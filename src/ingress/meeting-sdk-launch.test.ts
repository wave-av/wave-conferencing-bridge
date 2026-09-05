import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryMediaTapMeter,
  inertJoinClient,
  inertWhipPublisher,
  launchMeetingSdkBot,
  launchMeetingSdkBotFarm,
} from './meeting-sdk-launch.js';
import {
  isMeetingSdkIngressEnabled,
  MEETING_SDK_INGRESS_FLAG,
  type MeetingMediaCapture,
  type MeetingSdkJoinClient,
  type MeetingSdkLaunchDeps,
  type WhipPublisher,
} from '../types/meeting-sdk-launch.js';

const baseBot = {
  meetingNumber: '12345678901',
  video: { uri: 'file:///media/loop.mp4' },
  waveTarget: { mode: 'whip', whipUrl: 'https://rt.wave.online/whip', streamKey: 'live_test_key' },
} as const;

const armedEnv = {
  ZOOM_APPS_CLIENT_ID: 'k',
  ZOOM_APPS_CLIENT_SECRET: 's',
} as NodeJS.ProcessEnv;

const enabledArmedEnv = {
  ...armedEnv,
  [MEETING_SDK_INGRESS_FLAG]: '1',
} as NodeJS.ProcessEnv;

/** A fake join client that yields a controllable capture, recording stops. */
function fakeClient(): { client: MeetingSdkJoinClient; stops: string[] } {
  const stops: string[] = [];
  const client: MeetingSdkJoinClient = {
    join(params) {
      const capture: MeetingMediaCapture = {
        captureId: `cap-${params.meetingNumber}`,
        kind: 'composited',
        stop: async () => {
          stops.push(`cap-${params.meetingNumber}`);
        },
      };
      return Promise.resolve(capture);
    },
  };
  return { client, stops };
}

function fakePublisher(): { publisher: WhipPublisher; stops: string[] } {
  const stops: string[] = [];
  const publisher: WhipPublisher = {
    publish(req) {
      return Promise.resolve({
        resourceUrl: `${req.whipUrl}/res/${req.streamKey}`,
        stop: async () => {
          stops.push(req.streamKey);
        },
      });
    },
  };
  return { publisher, stops };
}

function armedDeps(extra: Partial<MeetingSdkLaunchDeps> = {}): {
  deps: MeetingSdkLaunchDeps;
  clientStops: string[];
  pubStops: string[];
} {
  const { client, stops: clientStops } = fakeClient();
  const { publisher, stops: pubStops } = fakePublisher();
  return {
    deps: { client, publisher, now: () => 1_720_000_000, ...extra },
    clientStops,
    pubStops,
  };
}

describe('isMeetingSdkIngressEnabled — flag defaults OFF', () => {
  it('is false when the flag env is absent', () => {
    expect(isMeetingSdkIngressEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('honors truthy tokens and rejects everything else', () => {
    for (const on of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      expect(isMeetingSdkIngressEnabled({ [MEETING_SDK_INGRESS_FLAG]: on } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const off of ['0', 'false', '', 'nope', 'off']) {
      expect(isMeetingSdkIngressEnabled({ [MEETING_SDK_INGRESS_FLAG]: off } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

describe('launchMeetingSdkBot — double gate, INERT by default', () => {
  it('is planning-only (flag-off) when the flag is absent, even if armed', async () => {
    const spy = vi.spyOn(inertJoinClient, 'join');
    const r = await launchMeetingSdkBot(baseBot, {}, armedEnv);
    expect(r.status).toBe('planning-only');
    if (r.status === 'planning-only') expect(r.reason).toBe('flag-off');
    expect(r.binding.armed).toBe(true); // credential present, but flag gates the join
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is planning-only (credential-absent) when the flag is on but no credential', async () => {
    const r = await launchMeetingSdkBot(
      baseBot,
      {},
      { [MEETING_SDK_INGRESS_FLAG]: '1' } as NodeJS.ProcessEnv,
    );
    expect(r.status).toBe('planning-only');
    if (r.status === 'planning-only') expect(r.reason).toBe('credential-absent');
  });

  it('touches NO seam on the planning-only path (default inert stubs never invoked)', async () => {
    // Default deps are the throwing stubs; a planning-only launch must not call them.
    await expect(launchMeetingSdkBot(baseBot, {}, {} as NodeJS.ProcessEnv)).resolves.toMatchObject({
      status: 'planning-only',
    });
  });

  it('joins, signs, meters and republishes over WHIP when flag ON + armed', async () => {
    const { deps, clientStops, pubStops } = armedDeps();
    const meter = createInMemoryMediaTapMeter();
    const r = await launchMeetingSdkBot(baseBot, { ...deps, meter }, enabledArmedEnv);
    expect(r.status).toBe('joined');
    if (r.status !== 'joined') return;
    expect(r.publication.resourceUrl).toBe('https://rt.wave.online/whip/res/live_test_key');
    expect(r.capture.captureId).toBe('cap-12345678901');
    expect(meter.total('live_test_key')).toBeGreaterThan(0); // metered through #91 seam
    await r.stop();
    expect(pubStops).toEqual(['live_test_key']);
    expect(clientStops).toEqual(['cap-12345678901']);
  });

  it('tears down the capture if WHIP publish fails (no leaked join)', async () => {
    const { client, stops: clientStops } = fakeClient();
    const publisher: WhipPublisher = { publish: () => Promise.reject(new Error('whip boom')) };
    await expect(
      launchMeetingSdkBot(baseBot, { client, publisher, now: () => 1_720_000_000 }, enabledArmedEnv),
    ).rejects.toThrow('whip boom');
    expect(clientStops).toEqual(['cap-12345678901']); // capture was stopped
  });

  it('refuses to launch a headless bot against an RTMP target', async () => {
    const { deps } = armedDeps();
    const rtmpBot = { ...baseBot, waveTarget: { mode: 'rtmp', streamKey: 'live_test_key' } };
    await expect(launchMeetingSdkBot(rtmpBot, deps, enabledArmedEnv)).rejects.toThrow(/WHIP/);
  });
});

describe('inert default seams fail closed', () => {
  it('inertJoinClient throws rather than joining a real meeting', async () => {
    await expect(inertJoinClient.join({} as never)).rejects.toThrow(/INERT/);
  });

  it('inertWhipPublisher throws rather than emitting bytes', async () => {
    await expect(inertWhipPublisher.publish({} as never)).rejects.toThrow(/INERT/);
  });
});

describe('launchMeetingSdkBotFarm', () => {
  it('returns planning-only for every bot when the flag is off', async () => {
    const results = await launchMeetingSdkBotFarm({ bot: baseBot, count: 3 }, {}, armedEnv);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'planning-only')).toBe(true);
  });

  it('joins all N bots when armed + enabled', async () => {
    const { deps } = armedDeps();
    const results = await launchMeetingSdkBotFarm(
      { bot: baseBot, count: 3, staggerMs: 0 },
      deps,
      enabledArmedEnv,
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'joined')).toBe(true);
    // Cleanup every publication.
    await Promise.all(results.map((r) => (r.status === 'joined' ? r.stop() : Promise.resolve())));
  });
});
