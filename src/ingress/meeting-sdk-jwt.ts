/**
 * Zoom Meeting-SDK join-signature (JWT) signer — task #88/M2.
 *
 * A synthetic bot authenticates its Meeting-SDK join with a short-lived HS256 JWT
 * signed by the SDK Key/Secret. Standalone "Meeting SDK" apps are deprecated, so
 * the SDK Key/Secret are the WAVE General app's Client ID / Client Secret
 * (ZOOM_APPS_CLIENT_ID / ZOOM_APPS_CLIENT_SECRET — see meeting-sdk types). This is
 * the server-side counterpart to the RTMS auth primitives in wave-realtime-edge:
 * a pure, deterministic signer with NO network and NO env access — the caller (the
 * Wave-2 launcher, under `doppler run`) passes the credential VALUES in; this module
 * never reads env and never logs the secret.
 *
 * Signing MUST stay server-side: the signature is minted here and handed to the bot,
 * never the SDK Secret itself. Per Zoom's spec the token is HS256 over
 * `base64url(header).base64url(payload)`, payload `{ appKey, sdkKey, mn, role, iat,
 * exp, tokenExp }`, with `exp` at most 48h out.
 */
import { createHmac } from 'node:crypto';

/** Zoom's maximum Meeting-SDK token lifetime: 48 hours (seconds). */
export const MEETING_SDK_MAX_TTL_SEC = 48 * 60 * 60;

/** Meeting-SDK role: 0 = attendee/participant (a perception bot), 1 = host. */
export type MeetingSdkRole = 0 | 1;

export interface MeetingSdkJwtParams {
  /** SDK Key = ZOOM_APPS_CLIENT_ID value (passed in by the launcher; never read from env here). */
  sdkKey: string;
  /** SDK Secret = ZOOM_APPS_CLIENT_SECRET value. Used only to sign; never logged or returned. */
  sdkSecret: string;
  /** Zoom meeting number (9–11 digits). */
  meetingNumber: string;
  /** 0 = attendee (default for a perception bot), 1 = host. */
  role?: MeetingSdkRole;
  /** Issued-at (unix seconds). Injectable so the token is deterministic in tests. */
  iat: number;
  /** Expiry (unix seconds). Must satisfy iat < exp <= iat + MEETING_SDK_MAX_TTL_SEC. */
  exp: number;
}

/** base64url-encode a string or Buffer (RFC 7515: +→-, /→_, no `=` padding). */
export function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign an HS256 JWT (compact form) for the given header/payload objects with `secret`. */
export function signHs256Jwt(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error('meeting-sdk jwt: signing secret must not be empty');
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

/**
 * Build the Zoom Meeting-SDK join JWT. Validates the credential + lifetime bounds and
 * fails CLOSED (throws) on anything malformed — an empty key/secret, a bad meeting
 * number, or an out-of-range lifetime — so a broken token can never reach a join.
 */
export function meetingSdkJwt(params: MeetingSdkJwtParams): string {
  const { sdkKey, sdkSecret, meetingNumber, role = 0, iat, exp } = params;
  if (!sdkKey) throw new Error('meeting-sdk jwt: sdkKey must not be empty');
  if (!sdkSecret) throw new Error('meeting-sdk jwt: sdkSecret must not be empty');
  if (!/^\d{9,11}$/.test(meetingNumber)) throw new Error('meeting-sdk jwt: meetingNumber must be 9-11 digits');
  if (role !== 0 && role !== 1) throw new Error('meeting-sdk jwt: role must be 0 or 1');
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw new Error('meeting-sdk jwt: iat/exp must be integer unix seconds');
  if (iat <= 0) throw new Error('meeting-sdk jwt: iat must be a positive unix timestamp');
  if (exp <= iat) throw new Error('meeting-sdk jwt: exp must be after iat');
  if (exp - iat > MEETING_SDK_MAX_TTL_SEC) throw new Error('meeting-sdk jwt: lifetime exceeds the 48h Zoom maximum');
  const header = { alg: 'HS256', typ: 'JWT' };
  // `appKey` and `sdkKey` both carry the SDK Key (Zoom accepts either across SDK versions); `tokenExp`
  // mirrors `exp` (the SDK reads tokenExp for its own session-expiry handling).
  const payload = { appKey: sdkKey, sdkKey, mn: meetingNumber, role, iat, exp, tokenExp: exp };
  return signHs256Jwt(header, payload, sdkSecret);
}
