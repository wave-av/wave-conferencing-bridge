/**
 * Process-driver adapter — task #88/M2 native driver, item 2.
 *
 * Fills `MeetingSdkJoinClient.join()` (see `../types/meeting-sdk-launch.ts`) by
 * spawning and supervising the native Zoom Meeting-SDK-for-Linux headless bot
 * binary (see `../../native/`) over a line-delimited JSON stdio IPC contract.
 * The TS adapter here is real; the native binary it spawns is the host-gated
 * piece — it does not exist on this machine (x86_64 Linux + Zoom SDK only, see
 * `native/HOST-REQUIREMENTS.md`). FAIL-CLOSED: if the binary path is unset or
 * the file does not exist, `join()` rejects before ever spawning anything.
 *
 * IPC contract (full detail: `native/ADAPTATION.md`):
 *
 *   TS → native (stdin, one JSON object per line):
 *     {"cmd":"join","signature","meetingNumber","passcode"?,"botDisplayName","video"}
 *     {"cmd":"leave"}
 *
 *   native → TS (stdout, one JSON object per line):
 *     {"type":"ready"}                                  — SDK initialized, about to join
 *     {"type":"joined","captureId","kind":"raw"|"composited"}  — resolves join()
 *     {"type":"media-frame","seq","bytes"}               — periodic capture heartbeat (informational)
 *     {"type":"left"}                                    — leave acknowledged
 *     {"type":"error","message"}                          — fatal error at any stage
 *
 * stderr is buffered (bounded) and surfaced in error messages on an unexpected
 * exit, so a native-process crash is diagnosable from the TS side.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import type {
  MeetingMediaCapture,
  MeetingSdkJoinClient,
  MeetingSdkJoinParams,
} from '../types/meeting-sdk-launch.js';
import { isMeetingSdkIngressEnabled } from '../types/meeting-sdk-launch.js';
import { inertJoinClient } from './meeting-sdk-launch.js';

/** Env var naming the absolute path to the native headless bot binary. Absent on non-Linux hosts by design. */
export const MEETING_SDK_BOT_BINARY_ENV = 'MEETING_SDK_BOT_BINARY';

/** Default bound on stdout stderr buffering kept for error diagnostics (bytes). */
const STDERR_TAIL_BYTES = 4096;

/** Minimal surface of `node:child_process`'s `ChildProcess` this driver needs — injectable for tests. */
export interface ChildProcessLike {
  readonly stdin: { write(chunk: string): void } | null;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (binaryPath: string) => ChildProcessLike;

/** Thrown when `join()` is invoked with no binary path configured, or the configured path doesn't exist. */
export class MeetingSdkBotUnavailableError extends Error {
  override readonly name = 'MeetingSdkBotUnavailableError';
}

/** Thrown when the native process reports `{"type":"error"}` or exits before joining. */
export class MeetingSdkBotProcessError extends Error {
  override readonly name = 'MeetingSdkBotProcessError';
}

/** Thrown when `ready`/`joined` doesn't arrive within the configured timeout. */
export class MeetingSdkBotTimeoutError extends Error {
  override readonly name = 'MeetingSdkBotTimeoutError';
}

interface InboundMessage {
  type: 'ready' | 'joined' | 'media-frame' | 'left' | 'error';
  captureId?: string;
  kind?: 'raw' | 'composited';
  message?: string;
  [k: string]: unknown;
}

export interface ProcessMeetingSdkJoinClientOptions {
  /** Absolute path to the native bot binary. Defaults to `env[MEETING_SDK_BOT_BINARY_ENV]`. */
  binaryPath?: string;
  /** Spawns the child process. Defaults to `node:child_process.spawn` with piped stdio. Tests inject a fake. */
  spawnFn?: SpawnFn;
  /** Checks the binary exists. Defaults to `fs.existsSync`. Tests inject a stub so a fake path passes. */
  existsFn?: (path: string) => boolean;
  /** Ms to wait for `{"type":"joined"}` before failing the join. Default 15s. */
  joinTimeoutMs?: number;
  /** Ms to wait for `{"type":"left"}`/exit before force-killing on `stop()`. Default 5s. */
  leaveTimeoutMs?: number;
  /** Optional sink for `{"type":"media-frame"}` telemetry messages. */
  onMediaFrame?: (msg: InboundMessage) => void;
}

function parseLines(buf: { text: string }, chunk: Buffer | string, onLine: (line: string) => void): void {
  buf.text += chunk.toString('utf8');
  let idx: number;
  while ((idx = buf.text.indexOf('\n')) >= 0) {
    const line = buf.text.slice(0, idx).trim();
    buf.text = buf.text.slice(idx + 1);
    if (line) onLine(line);
  }
}

function appendTail(tail: { text: string }, chunk: Buffer | string): void {
  tail.text = (tail.text + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
}

/**
 * Real `MeetingSdkJoinClient`: spawns the native bot binary, drives the
 * join→ready→media-frames→leave IPC lifecycle over stdio, and returns a
 * `MeetingMediaCapture` bound to that child process.
 */
export class ProcessMeetingSdkJoinClient implements MeetingSdkJoinClient {
  constructor(private readonly opts: ProcessMeetingSdkJoinClientOptions = {}) {}

  async join(params: MeetingSdkJoinParams): Promise<MeetingMediaCapture> {
    const binaryPath = this.opts.binaryPath ?? process.env[MEETING_SDK_BOT_BINARY_ENV];
    if (!binaryPath) {
      throw new MeetingSdkBotUnavailableError(
        `meeting-sdk process driver: ${MEETING_SDK_BOT_BINARY_ENV} is not set — refusing to spawn (INERT/fail-closed)`,
      );
    }
    const existsFn = this.opts.existsFn ?? existsSync;
    if (!existsFn(binaryPath)) {
      throw new MeetingSdkBotUnavailableError(
        `meeting-sdk process driver: bot binary not found at '${binaryPath}' (host-gated — needs the native ` +
          'Meeting-SDK-for-Linux build; see native/HOST-REQUIREMENTS.md) — refusing to spawn (fail-closed)',
      );
    }

    const spawnFn = this.opts.spawnFn ?? defaultSpawnFn;
    const joinTimeoutMs = this.opts.joinTimeoutMs ?? 15_000;
    const leaveTimeoutMs = this.opts.leaveTimeoutMs ?? 5_000;
    const child = spawnFn(binaryPath);

    const stderrTail = { text: '' };
    child.stderr?.on('data', (chunk) => appendTail(stderrTail, chunk));

    const capture = await new Promise<MeetingMediaCapture>((resolve, reject) => {
      let settled = false;
      const outBuf = { text: '' };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(
          new MeetingSdkBotTimeoutError(
            `meeting-sdk process driver: no 'joined' message within ${joinTimeoutMs}ms (stderr: ${stderrTail.text || '<empty>'})`,
          ),
        );
      }, joinTimeoutMs);

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new MeetingSdkBotProcessError(
            `meeting-sdk process driver: process exited before joining (code=${code}, signal=${signal}, stderr: ${
              stderrTail.text || '<empty>'
            })`,
          ),
        );
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new MeetingSdkBotProcessError(`meeting-sdk process driver: spawn failed: ${err.message}`));
      };

      child.on('exit', onExit);
      child.on('error', onError);

      child.stdout?.on('data', (chunk) => {
        parseLines(outBuf, chunk, (line) => {
          let msg: InboundMessage;
          try {
            msg = JSON.parse(line) as InboundMessage;
          } catch {
            return; // ignore unparseable stdout noise (native logging, etc.)
          }
          if (msg.type === 'media-frame') {
            this.opts.onMediaFrame?.(msg);
            return;
          }
          if (msg.type === 'error') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new MeetingSdkBotProcessError(`meeting-sdk process driver: native error: ${msg.message ?? 'unknown'}`));
            return;
          }
          if (msg.type === 'joined') {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!msg.captureId || (msg.kind !== 'raw' && msg.kind !== 'composited')) {
              reject(new MeetingSdkBotProcessError(`meeting-sdk process driver: malformed 'joined' message: ${line}`));
              return;
            }
            resolve(buildCapture(child, msg.captureId, msg.kind, leaveTimeoutMs));
          }
          // 'ready' is informational — no action needed, we wait for 'joined'.
        });
      });

      const cmd = {
        cmd: 'join',
        signature: params.signature,
        meetingNumber: params.meetingNumber,
        passcode: params.passcode,
        botDisplayName: params.botDisplayName,
        video: params.video,
      };
      child.stdin?.write(JSON.stringify(cmd) + '\n');
    });

    return capture;
  }
}

function buildCapture(
  child: ChildProcessLike,
  captureId: string,
  kind: 'raw' | 'composited',
  leaveTimeoutMs: number,
): MeetingMediaCapture {
  let stopped = false;
  return {
    captureId,
    kind,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, leaveTimeoutMs);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.stdin?.write(JSON.stringify({ cmd: 'leave' }) + '\n');
        } catch {
          // stdin may already be closed if the process died; the exit/timeout handlers still resolve.
        }
      });
    },
  };
}

/** Live spawn: pipes all three stdio streams so the JSON-lines IPC + stderr diagnostics both work. */
function defaultSpawnFn(binaryPath: string): ChildProcessLike {
  return spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildProcessLike;
}

/**
 * Selects the real process-driver join client only when the Wave-2 ingress
 * flag is ON; otherwise returns the INERT default (`inertJoinClient`, which
 * throws). Mirrors `resolveWhipPublisher` in `gateway-whip-publisher.ts` —
 * kept out of `meeting-sdk-launch.ts` so its flag-off defaults stay untouched.
 */
export function resolveJoinClient(
  env: NodeJS.ProcessEnv = process.env,
  opts: ProcessMeetingSdkJoinClientOptions = {},
): MeetingSdkJoinClient {
  return isMeetingSdkIngressEnabled(env) ? new ProcessMeetingSdkJoinClient(opts) : inertJoinClient;
}
