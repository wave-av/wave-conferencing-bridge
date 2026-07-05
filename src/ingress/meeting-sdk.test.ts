import { describe, expect, it } from 'vitest';

import {
  bindMeetingSdkIngress,
  isMeetingSdkArmed,
  planMeetingSdkBotFarm,
} from './meeting-sdk.js';
import {
  DEFAULT_MEETING_SDK_CREDENTIAL_REF,
  MeetingSdkBotConfigSchema,
  type MeetingSdkBotConfig,
} from '../types/meeting-sdk.js';

const baseBot: unknown = {
  meetingNumber: '12345678901',
  video: { uri: 'file:///media/loop.mp4' },
  waveTarget: { mode: 'whip', whipUrl: 'https://rt.wave.online/whip', streamKey: 'live_test_key' },
};

const armedEnv = {
  ZOOM_APPS_CLIENT_ID: 'k',
  ZOOM_APPS_CLIENT_SECRET: 's',
} as NodeJS.ProcessEnv;

describe('meeting-sdk types', () => {
  it('applies defaults for name, credentialRef, loop, fps', () => {
    const cfg: MeetingSdkBotConfig = MeetingSdkBotConfigSchema.parse(baseBot);
    expect(cfg.botDisplayName).toBe('WAVE Perception Bot');
    expect(cfg.credentialRef).toEqual(DEFAULT_MEETING_SDK_CREDENTIAL_REF);
    expect(cfg.video.loop).toBe(true);
    expect(cfg.video.fps).toBe(30);
  });

  it('rejects a malformed meeting number', () => {
    expect(() => MeetingSdkBotConfigSchema.parse({ ...(baseBot as object), meetingNumber: 'nope' })).toThrow();
  });

  it('discriminates whip vs rtmp targets', () => {
    const rtmp = MeetingSdkBotConfigSchema.parse({
      ...(baseBot as object),
      waveTarget: { mode: 'rtmp', streamKey: 'live_test_key' },
    });
    expect(rtmp.waveTarget.mode).toBe('rtmp');
  });
});

describe('bindMeetingSdkIngress (inert by default)', () => {
  it('is INERT when the Meeting-SDK credential env is absent', () => {
    const b = bindMeetingSdkIngress(baseBot, {} as NodeJS.ProcessEnv);
    expect(b.armed).toBe(false);
    expect(b.plan).toContain('INERT');
    expect(b.requiredEnv).toEqual(['ZOOM_APPS_CLIENT_ID', 'ZOOM_APPS_CLIENT_SECRET']);
    expect(b.joinDelayMs).toBe(0);
  });

  it('arms only when BOTH credential env vars are present', () => {
    expect(bindMeetingSdkIngress(baseBot, { ZOOM_APPS_CLIENT_ID: 'k' } as NodeJS.ProcessEnv).armed).toBe(false);
    const armed = bindMeetingSdkIngress(baseBot, armedEnv);
    expect(armed.armed).toBe(true);
    expect(armed.plan).toContain('join meeting 12345678901');
    expect(armed.plan).toContain('whip');
  });

  it('isMeetingSdkArmed honors custom credentialRef names', () => {
    const cfg = MeetingSdkBotConfigSchema.parse({
      ...(baseBot as object),
      credentialRef: { keyEnv: 'MY_KEY', secretEnv: 'MY_SECRET' },
    });
    expect(isMeetingSdkArmed(cfg, { MY_KEY: 'a', MY_SECRET: 'b' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isMeetingSdkArmed(cfg, armedEnv)).toBe(false);
  });
});

describe('planMeetingSdkBotFarm', () => {
  it('plans one bot by default', () => {
    const farm = planMeetingSdkBotFarm({ bot: baseBot }, {} as NodeJS.ProcessEnv);
    expect(farm).toHaveLength(1);
    expect(farm[0]?.joinDelayMs).toBe(0);
  });

  it('plans N bots with unique names and staggered joins', () => {
    const farm = planMeetingSdkBotFarm({ bot: baseBot, count: 3, staggerMs: 1500 }, armedEnv);
    expect(farm).toHaveLength(3);
    expect(farm.map((b) => b.botDisplayName)).toEqual([
      'WAVE Perception Bot',
      'WAVE Perception Bot 2',
      'WAVE Perception Bot 3',
    ]);
    expect(farm.map((b) => b.joinDelayMs)).toEqual([0, 1500, 3000]);
    expect(farm.every((b) => b.armed)).toBe(true);
  });

  it('rejects a farm larger than the cap', () => {
    expect(() => planMeetingSdkBotFarm({ bot: baseBot, count: 999 })).toThrow();
  });
});
