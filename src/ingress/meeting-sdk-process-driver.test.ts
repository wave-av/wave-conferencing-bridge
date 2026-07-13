import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { MeetingSdkJoinParams } from '../types/meeting-sdk-launch.js';
import { MEETING_SDK_INGRESS_FLAG } from '../types/meeting-sdk-launch.js';
import { inertJoinClient } from './meeting-sdk-launch.js';
import {
  MEETING_SDK_BOT_BINARY_ENV,
  MeetingSdkBotProcessError,
  MeetingSdkBotTimeoutError,
  MeetingSdkBotUnavailableError,
  ProcessMeetingSdkJoinClient,
  resolveJoinClient,
  type ChildProcessLike,
} from './meeting-sdk-process-driver.js';

const params: MeetingSdkJoinParams = {
  signature: 'sig.jwt.here',
  meetingNumber: '12345678901',
  botDisplayName: 'WAVE Perception Bot',
  video: { uri: 'file:///media/loop.mp4', loop: true, fps: 30 },
};

/** A fake child process the adapter can drive: captures stdin writes, lets tests push stdout/stderr/exit. */
class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly writes: string[] = [];
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];
  private readonly outEmitter = new EventEmitter();
  private readonly errEmitter = new EventEmitter();

  readonly stdin = { write: (chunk: string) => void this.writes.push(chunk) };
  readonly stdout = { on: (event: 'data', l: (c: Buffer | string) => void) => void this.outEmitter.on(event, l) };
  readonly stderr = { on: (event: 'data', l: (c: Buffer | string) => void) => void this.errEmitter.on(event, l) };

  emitStdout(line: string): void {
    this.outEmitter.emit('data', line + '\n');
  }
  emitStderr(text: string): void {
    this.errEmitter.emit('data', text);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.emit('exit', null, signal ?? null);
    return true;
  }
}

function driver(child: FakeChild, over: Partial<Parameters<typeof mkOpts>[0]> = {}) {
  return new ProcessMeetingSdkJoinClient(
    mkOpts({
      binaryPath: '/opt/wave/meeting-sdk-bot',
      spawnFn: () => child,
      existsFn: () => true,
      ...over,
    }),
  );
}

function mkOpts<T extends Record<string, unknown>>(o: T): T {
  return o;
}

describe('ProcessMeetingSdkJoinClient — fail-closed on missing binary', () => {
  it('rejects when no binary path is configured (env absent)', async () => {
    const client = new ProcessMeetingSdkJoinClient({ existsFn: () => true, spawnFn: () => new FakeChild() });
    await expect(client.join(params)).rejects.toBeInstanceOf(MeetingSdkBotUnavailableError);
  });

  it('rejects when the configured path does not exist on disk', async () => {
    const client = new ProcessMeetingSdkJoinClient({
      binaryPath: '/opt/wave/meeting-sdk-bot',
      existsFn: () => false,
      spawnFn: () => new FakeChild(),
    });
    await expect(client.join(params)).rejects.toBeInstanceOf(MeetingSdkBotUnavailableError);
  });
});

describe('ProcessMeetingSdkJoinClient — IPC lifecycle', () => {
  it('writes a join cmd line, resolves on {type:"joined"}, ignores ready/media-frame', async () => {
    const child = new FakeChild();
    const mediaFrames: unknown[] = [];
    const client = driver(child, { onMediaFrame: (m: unknown) => mediaFrames.push(m) });

    const joinP = client.join(params);
    // Let the adapter attach listeners + write stdin before we push stdout.
    await Promise.resolve();
    expect(JSON.parse(child.writes[0] ?? '{}')).toMatchObject({ cmd: 'join', meetingNumber: '12345678901' });

    child.emitStdout(JSON.stringify({ type: 'ready' }));
    child.emitStdout(JSON.stringify({ type: 'media-frame', seq: 1, bytes: 4096 }));
    child.emitStdout(JSON.stringify({ type: 'joined', captureId: 'cap-1', kind: 'raw' }));

    const capture = await joinP;
    expect(capture.captureId).toBe('cap-1');
    expect(capture.kind).toBe('raw');
    expect(mediaFrames).toHaveLength(1);
  });

  it('rejects with MeetingSdkBotProcessError on {type:"error"}', async () => {
    const child = new FakeChild();
    const client = driver(child);
    const joinP = client.join(params);
    await Promise.resolve();
    child.emitStdout(JSON.stringify({ type: 'error', message: 'zoom sdk init failed' }));
    await expect(joinP).rejects.toBeInstanceOf(MeetingSdkBotProcessError);
  });

  it('rejects with MeetingSdkBotProcessError if the process exits before joining', async () => {
    const child = new FakeChild();
    const client = driver(child);
    const joinP = client.join(params);
    await Promise.resolve();
    child.emit('exit', 1, null);
    await expect(joinP).rejects.toBeInstanceOf(MeetingSdkBotProcessError);
  });

  it('times out and kills the process if no joined message arrives', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = driver(child, { joinTimeoutMs: 1000 });
    const assertion = expect(client.join(params)).rejects.toBeInstanceOf(MeetingSdkBotTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(child.killSignals).toContain('SIGTERM');
    vi.useRealTimers();
  });

  it('capture.stop() sends leave and resolves on process exit', async () => {
    const child = new FakeChild();
    const client = driver(child);
    const joinP = client.join(params);
    await Promise.resolve();
    child.emitStdout(JSON.stringify({ type: 'joined', captureId: 'cap-1', kind: 'composited' }));
    const capture = await joinP;

    const stopP = capture.stop();
    await Promise.resolve();
    expect(JSON.parse(child.writes[1] ?? '{}')).toMatchObject({ cmd: 'leave' });
    child.emit('exit', 0, null);
    await stopP;
  });

  it('capture.stop() force-kills after the leave timeout', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const client = driver(child, { leaveTimeoutMs: 500 });
    const joinP = client.join(params);
    await Promise.resolve();
    child.emitStdout(JSON.stringify({ type: 'joined', captureId: 'cap-1', kind: 'composited' }));
    const capture = await joinP;

    const stopP = capture.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopP;
    expect(child.killSignals).toContain('SIGKILL');
    vi.useRealTimers();
  });

  it('capture.stop() is idempotent', async () => {
    const child = new FakeChild();
    const client = driver(child);
    const joinP = client.join(params);
    await Promise.resolve();
    child.emitStdout(JSON.stringify({ type: 'joined', captureId: 'cap-1', kind: 'composited' }));
    const capture = await joinP;

    const stopP = capture.stop();
    await Promise.resolve();
    child.emit('exit', 0, null);
    await stopP;
    const writesBefore = child.writes.length;
    await capture.stop();
    expect(child.writes.length).toBe(writesBefore); // no second 'leave' write
  });
});

describe('resolveJoinClient — selected only when the ingress flag is on', () => {
  it('returns the inert client when the flag is absent', () => {
    expect(resolveJoinClient({} as NodeJS.ProcessEnv)).toBe(inertJoinClient);
  });

  it('returns a real process driver when the flag is on', () => {
    const client = resolveJoinClient({ [MEETING_SDK_INGRESS_FLAG]: '1' } as NodeJS.ProcessEnv, {
      binaryPath: '/opt/wave/meeting-sdk-bot',
    });
    expect(client).not.toBe(inertJoinClient);
    expect(client).toBeInstanceOf(ProcessMeetingSdkJoinClient);
  });

  it('honors an explicit env binary path option key name', () => {
    // Sanity: the exported env var name matches what the docs promise.
    expect(MEETING_SDK_BOT_BINARY_ENV).toBe('MEETING_SDK_BOT_BINARY');
  });
});
