import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import {
  base64Url,
  signHs256Jwt,
  meetingSdkJwt,
  MEETING_SDK_MAX_TTL_SEC,
} from './meeting-sdk-jwt.js';

/** Decode a base64url JWT segment back to a parsed object. */
function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('signHs256Jwt — pinned to the canonical jwt.io HS256 vector', () => {
  it('reproduces the published token for the well-known header/payload/secret', () => {
    // The canonical jwt.io example: proves base64url + HMAC-SHA256 assembly is correct,
    // not merely self-consistent.
    const token = signHs256Jwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: '1234567890', name: 'John Doe', iat: 1516239022 },
      'your-256-bit-secret',
    );
    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
        '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ' +
        '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    );
  });

  it('throws on an empty signing secret (never signs with a zero-length key)', () => {
    expect(() => signHs256Jwt({ alg: 'HS256', typ: 'JWT' }, { a: 1 }, '')).toThrow(/secret/);
  });
});

describe('base64Url', () => {
  it('is URL-safe and unpadded', () => {
    // 0xFB 0xFF encodes to "+/8" in std base64 → "-_8" url-safe, no "=" padding.
    expect(base64Url(Buffer.from([0xfb, 0xff]))).toBe('-_8');
  });
});

describe('meetingSdkJwt', () => {
  const base = {
    sdkKey: 'ovEysWTpSDSTi2Oayra16g',
    sdkSecret: 'test-sdk-secret-value',
    meetingNumber: '12345678901',
    iat: 1720000000,
    exp: 1720003600, // +1h
  };

  it('emits a three-part token whose payload carries the Zoom Meeting-SDK claims', () => {
    const token = meetingSdkJwt(base);
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(decodeSegment(h)).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(decodeSegment(p)).toEqual({
      appKey: base.sdkKey,
      sdkKey: base.sdkKey,
      mn: base.meetingNumber,
      role: 0,
      iat: base.iat,
      exp: base.exp,
      tokenExp: base.exp,
    });
    // Signature verifies under the SDK secret (independent recompute).
    const expectedSig = createHmac('sha256', base.sdkSecret).update(`${h}.${p}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(s).toBe(expectedSig);
    expect(token.split('.')).toHaveLength(3);
  });

  it('defaults role to attendee (0) and honours role 1 (host)', () => {
    expect(decodeSegment(meetingSdkJwt(base).split('.')[1]!).role).toBe(0);
    expect(decodeSegment(meetingSdkJwt({ ...base, role: 1 }).split('.')[1]!).role).toBe(1);
  });

  it('fails closed on bad credentials / meeting number / lifetime', () => {
    expect(() => meetingSdkJwt({ ...base, sdkKey: '' })).toThrow(/sdkKey/);
    expect(() => meetingSdkJwt({ ...base, sdkSecret: '' })).toThrow(/sdkSecret|secret/);
    expect(() => meetingSdkJwt({ ...base, meetingNumber: '123' })).toThrow(/meetingNumber/);
    expect(() => meetingSdkJwt({ ...base, exp: base.iat })).toThrow(/after iat/);
    expect(() => meetingSdkJwt({ ...base, exp: base.iat + MEETING_SDK_MAX_TTL_SEC + 1 })).toThrow(/48h/);
  });
});
