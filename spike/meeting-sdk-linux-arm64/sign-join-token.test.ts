import { describe, expect, it } from 'vitest';

import { meetingSdkJwt } from '../../src/ingress/meeting-sdk-jwt.js';
import { loadSigner, paramsFromEnv, parseArgs } from './sign-join-token.mjs';

/** Decode a base64url JWT segment back to a parsed object (same helper as meeting-sdk-jwt.test.ts). */
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const env = {
  ZOOM_APPS_CLIENT_ID: 'ovEysWTpSDSTi2Oayra16g',
  ZOOM_APPS_CLIENT_SECRET: 'test-sdk-secret-value',
  ZOOM_MEETING_NUMBER: '12345678901',
};

describe('sign-join-token: paramsFromEnv', () => {
  it('maps the DEFAULT_MEETING_SDK_CREDENTIAL_REF env names onto the signer params', () => {
    const p = paramsFromEnv(env, 1720000000.9);
    expect(p).toEqual({
      sdkKey: env.ZOOM_APPS_CLIENT_ID,
      sdkSecret: env.ZOOM_APPS_CLIENT_SECRET,
      meetingNumber: env.ZOOM_MEETING_NUMBER,
      role: 0,
      iat: 1720000000,
      exp: 1720003600,
    });
  });

  it('honours --role / --ttl-sec and fails closed on missing env or a bad meeting number', () => {
    expect(paramsFromEnv(env, 100, { role: 1, ttlSec: 60 })).toMatchObject({ role: 1, iat: 100, exp: 160 });
    expect(() => paramsFromEnv({ ...env, ZOOM_APPS_CLIENT_ID: '' }, 100)).toThrow(/ZOOM_APPS_CLIENT_ID/);
    expect(() => paramsFromEnv({ ...env, ZOOM_APPS_CLIENT_SECRET: undefined }, 100)).toThrow(/ZOOM_APPS_CLIENT_SECRET/);
    expect(() => paramsFromEnv({ ...env, ZOOM_MEETING_NUMBER: '12-345' }, 100)).toThrow(/9-11 digits/);
    expect(() => paramsFromEnv(env, 100, { ttlSec: 0 })).toThrow(/ttl-sec/);
  });
});

describe('sign-join-token: parseArgs', () => {
  it('defaults to attendee + 1h, parses flags, rejects unknowns', () => {
    expect(parseArgs([])).toEqual({ role: 0, ttlSec: 3600 });
    expect(parseArgs(['--role', '1', '--ttl-sec', '120'])).toEqual({ role: 1, ttlSec: 120 });
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(() => parseArgs(['--role', '2'])).toThrow(/role/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('sign-join-token: end to end through the repo signer', () => {
  it('produces the same token as a direct meetingSdkJwt call with the Zoom claim shape', async () => {
    const { meetingSdkJwt: loaded } = await loadSigner();
    const params = paramsFromEnv(env, 1720000000);
    const token = loaded(params);
    expect(token).toBe(meetingSdkJwt(params));
    const [, payload] = token.split('.') as [string, string];
    expect(decodeSegment(payload)).toMatchObject({
      appKey: env.ZOOM_APPS_CLIENT_ID,
      sdkKey: env.ZOOM_APPS_CLIENT_ID,
      mn: env.ZOOM_MEETING_NUMBER,
      role: 0,
      tokenExp: 1720003600,
    });
    expect(token).not.toContain(env.ZOOM_APPS_CLIENT_SECRET);
  });
});
