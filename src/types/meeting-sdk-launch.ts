/**
 * Wave-2 launch types for the Meeting-SDK headless bot — task #88/M2.
 *
 * The M2 scaffold (`meeting-sdk.ts` + `meeting-sdk.ts` ingress + `meeting-sdk-jwt.ts`)
 * describes WHAT each synthetic bot will do; this file adds the shapes for the
 * actual Wave-2 join path: the runtime seams a bot drives when — and ONLY when —
 * it is ARMED (credential env present) AND its feature flag is ON. Everything is
 * still INERT by default: the flag defaults OFF/absent, so no seam is ever touched.
 *
 * The join path is expressed against injectable SEAMS, not hard-wired transports:
 *
 *   MeetingSdkJoinClient  — the headless Zoom Meeting-SDK client (native, Linux
 *                           bot-farm variant). The real driver is a later ◆; the
 *                           default is an inert stub that THROWS if invoked.
 *   MediaTapMeter         — the #91 one-subscribe media-tap surface the media is
 *                           metered through (M1 parity). Default: an in-memory
 *                           counting meter (no network).
 *   WhipPublisher         — republishes the captured media to the WaveTarget's
 *                           WHIP endpoint (wave-native path). Default: inert stub.
 *
 * Injecting the seams keeps the launcher pure + unit-testable with NO Zoom
 * dependency, NO network, and NO secret material in this repo.
 */

import { z } from 'zod';
import type { LoopedVideoSource, MeetingSdkBotBinding, WaveTarget } from './meeting-sdk.js';

/**
 * Env-var name of the Wave-2 arming flag. DEFAULTS OFF: when absent (or not a
 * truthy token) the launcher is planning-only and performs NO Zoom join — this
 * is the second gate on top of the credential-presence gate (`isMeetingSdkArmed`).
 * A join happens only when the flag is ON *and* the credential is present.
 */
export const MEETING_SDK_INGRESS_FLAG = 'ZOOM_MEETING_SDK_INGRESS_ENABLED';

/** Truthy tokens that turn the flag ON. Anything else (incl. absent) = OFF. */
const TRUTHY_FLAG = new Set(['1', 'true', 'yes', 'on']);

/**
 * The captured media handle a `MeetingSdkJoinClient.join` yields. Opaque here —
 * the shape of the raw/composited stream is the native driver's concern; the
 * launcher only forwards it to the meter + publisher and can stop it.
 */
export interface MeetingMediaCapture {
  /** Opaque native capture id (e.g. the SDK session/renderer handle id). */
  captureId: string;
  /** Media the bot pulled: 'raw' per-participant tracks or 'composited' gallery. */
  kind: 'raw' | 'composited';
  /** Release the native capture. Idempotent. */
  stop(): Promise<void>;
}

/** Parameters handed to the headless Meeting-SDK client to perform one join. */
export interface MeetingSdkJoinParams {
  /** The signed HS256 join JWT (from `meetingSdkJwt`). Never the SDK secret. */
  readonly signature: string;
  readonly meetingNumber: string;
  readonly passcode?: string;
  readonly botDisplayName: string;
  /** The looped, watermarked clip the bot presents as its camera. */
  readonly video: LoopedVideoSource;
}

/**
 * The headless Zoom Meeting-SDK client seam. The real implementation wraps the
 * native Meeting SDK (Linux bot-farm build); the default `inertJoinClient`
 * throws, so nothing joins a real meeting until a driver is injected AND the
 * flag is armed. A later ◆ ships the driver.
 */
export interface MeetingSdkJoinClient {
  join(params: MeetingSdkJoinParams): Promise<MeetingMediaCapture>;
}

/**
 * The #91 media-tap surface: media is metered through one subscribe (M1 parity)
 * so bot-farm traffic is accounted like any other WAVE feed. Kept as a seam —
 * the concrete tap lives outside this spec repo.
 */
export interface MediaTapMeter {
  /** Record `bytes` observed on the tap for `streamKey`. Cheap + synchronous. */
  record(streamKey: string, bytes: number): void;
  /** Total bytes metered for `streamKey` so far. */
  total(streamKey: string): number;
}

/** The WHIP publish request the launcher hands to the publisher seam. */
export interface WhipPublishRequest {
  readonly whipUrl: string;
  readonly streamKey: string;
  readonly capture: MeetingMediaCapture;
}

/** A live WHIP publication the bot is republishing into a WAVE room. */
export interface WhipPublication {
  /** WHIP resource URL the server allocated for this session (Location header). */
  resourceUrl: string;
  /** Tear down the publication. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Publishes captured media to the WaveTarget's WHIP endpoint. Default:
 * `inertWhipPublisher`, which throws — no bytes leave until a real transport is
 * injected and the flag is armed.
 */
export interface WhipPublisher {
  publish(req: WhipPublishRequest): Promise<WhipPublication>;
}

/** The credential VALUES the launcher signs with — passed in, never module-read. */
export interface MeetingSdkCredentials {
  readonly sdkKey: string;
  readonly sdkSecret: string;
}

/**
 * Outcome of a launch attempt. Discriminated on `status`:
 *  - `planning-only` — flag OFF and/or credential absent: NOTHING was joined,
 *    NO seam was touched. Carries the scaffold binding + why it stayed inert.
 *  - `joined` — flag ON + armed: the bot signed, joined, metered, and is
 *    republishing. Carries handles to stop the publication + capture.
 */
export type MeetingSdkLaunchResult =
  | {
      status: 'planning-only';
      binding: MeetingSdkBotBinding;
      /** Why it stayed inert: 'flag-off' | 'credential-absent'. */
      reason: 'flag-off' | 'credential-absent';
    }
  | {
      status: 'joined';
      binding: MeetingSdkBotBinding;
      waveTarget: WaveTarget;
      capture: MeetingMediaCapture;
      publication: WhipPublication;
      /** Stop publication then capture; idempotent. */
      stop(): Promise<void>;
    };

/** Optional overrides for a launch — every seam is injectable for tests + drivers. */
export interface MeetingSdkLaunchDeps {
  client?: MeetingSdkJoinClient;
  meter?: MediaTapMeter;
  publisher?: WhipPublisher;
  /** Resolve credential VALUES from the (already-armed) env. Injectable for tests. */
  resolveCredentials?: (env: NodeJS.ProcessEnv, keyEnv: string, secretEnv: string) => MeetingSdkCredentials;
  /** Clock (unix seconds) — injectable so signed tokens are deterministic in tests. */
  now?: () => number;
  /** Signed-token lifetime in seconds (<= the 48h Zoom max). Default 2h. */
  ttlSec?: number;
}

/** Zod echo of the flag semantics, so callers can validate a raw env string. */
export const MeetingSdkIngressFlagSchema = z
  .string()
  .transform((v) => TRUTHY_FLAG.has(v.trim().toLowerCase()));

/**
 * True iff the Wave-2 arming flag is ON. Absent env var => false (INERT default).
 */
export function isMeetingSdkIngressEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MEETING_SDK_INGRESS_FLAG];
  return typeof raw === 'string' && TRUTHY_FLAG.has(raw.trim().toLowerCase());
}
