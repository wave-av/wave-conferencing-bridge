/**
 * Meeting-SDK ingress: a synthetic bot JOINS a Zoom meeting via the Zoom
 * Meeting SDK, captures the meeting's raw media, and republishes it into WAVE.
 *
 * This is distinct from the RTMP ingress (see ./ingress.ts): there a human
 * operator pastes a WAVE push-URL into Zoom's own "Live stream" settings
 * (Zoom Pro, task #90/M3). Here NO human and NO Zoom-Pro live-stream is
 * involved — a headless bot authenticates with the Meeting SDK, joins as a
 * participant, and pulls the composited/raw stream. A "bot farm" runs N such
 * bots (each presenting a looped, watermarked video) to generate deterministic
 * synthetic meeting media for the perception pipeline (task #88/M2).
 *
 * Everything here is INERT: the schemas + planners describe what each bot WILL
 * do; the actual Meeting-SDK join is Wave-2 and is gated on the Meeting-SDK
 * credential being present at launch (see credentialRef). Absent credential =>
 * planning only, no Zoom join. We store the NAMES of the credential env vars,
 * never the values — the bot process reads them at launch under `doppler run`.
 */

import { z } from 'zod';

/**
 * Names (not values) of the env vars holding the Zoom Meeting-SDK credentials.
 * The Meeting-SDK "SDK Key"/"SDK Secret" are a DISTINCT credential from the
 * OAuth / Server-to-Server / Zoom-Apps client secrets — a separate Zoom
 * Marketplace "Meeting SDK" app (task #87). They are read from the environment
 * at bot launch; they never appear in config or in this repo.
 */
export const MeetingSdkCredentialRefSchema = z.object({
  keyEnv: z.string().min(1),
  secretEnv: z.string().min(1),
});
export type MeetingSdkCredentialRef = z.infer<typeof MeetingSdkCredentialRefSchema>;

/** Default credential env-var names, matching the WAVE Doppler convention. */
export const DEFAULT_MEETING_SDK_CREDENTIAL_REF: MeetingSdkCredentialRef = {
  keyEnv: 'ZOOM_MEETING_SDK_KEY',
  secretEnv: 'ZOOM_MEETING_SDK_SECRET',
};

/**
 * The looped video each synthetic bot presents as its camera. Using a looped,
 * watermarked clip makes bot-farm media deterministic and self-identifying in
 * the perception index.
 */
export const LoopedVideoSourceSchema = z.object({
  /** Path or URL to the source clip the bot presents as its camera. */
  uri: z.string().min(1),
  loop: z.boolean().default(true),
  fps: z.number().int().positive().max(60).default(30),
});
export type LoopedVideoSource = z.infer<typeof LoopedVideoSourceSchema>;

/**
 * Where the bot republishes the captured meeting media inside WAVE. WHIP is the
 * wave-native path (M1 parity); RTMP reuses the existing ingest for symmetry
 * with the M3 operator path. Discriminated on `mode` so each carries only its
 * relevant fields.
 */
export const WaveTargetSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('whip'),
    whipUrl: z.string().url(),
    streamKey: z.string().min(8),
  }),
  z.object({
    mode: z.literal('rtmp'),
    streamKey: z.string().min(8),
  }),
]);
export type WaveTarget = z.infer<typeof WaveTargetSchema>;

/** Config for a single synthetic Meeting-SDK bot. */
export const MeetingSdkBotConfigSchema = z.object({
  /** Zoom meeting number (9–11 digits, no spaces/dashes). */
  meetingNumber: z.string().regex(/^\d{9,11}$/, 'meetingNumber must be 9-11 digits'),
  /** Optional meeting passcode. */
  passcode: z.string().optional(),
  /** Display name the bot uses in the participant list. */
  botDisplayName: z.string().min(1).max(64).default('WAVE Perception Bot'),
  credentialRef: MeetingSdkCredentialRefSchema.default(DEFAULT_MEETING_SDK_CREDENTIAL_REF),
  video: LoopedVideoSourceSchema,
  waveTarget: WaveTargetSchema,
});
export type MeetingSdkBotConfig = z.infer<typeof MeetingSdkBotConfigSchema>;

/** Config for a farm of N identical bots joining the same meeting. */
export const MeetingSdkBotFarmConfigSchema = z.object({
  bot: MeetingSdkBotConfigSchema,
  /** How many bots to run. Capped to keep synthetic load bounded. */
  count: z.number().int().positive().max(50).default(1),
  /** Delay between successive bot joins, ms — avoids a thundering-herd join. */
  staggerMs: z.number().int().nonnegative().default(2000),
});
export type MeetingSdkBotFarmConfig = z.infer<typeof MeetingSdkBotFarmConfigSchema>;

/**
 * The resolved plan for one bot — what it will do once armed. Returned by the
 * ingress factory. `armed` is false until the Meeting-SDK credential env is
 * present at launch, at which point the (Wave-2) launcher performs the join.
 */
export interface MeetingSdkBotBinding {
  index: number;
  botDisplayName: string;
  meetingNumber: string;
  waveTarget: WaveTarget;
  video: LoopedVideoSource;
  /** Env var names that must be populated for this bot to actually join. */
  requiredEnv: string[];
  /** False until requiredEnv is present at launch (INERT otherwise). */
  armed: boolean;
  /** Delay before this bot joins, ms (0 for the first bot in a farm). */
  joinDelayMs: number;
  /** Human-readable description of what this bot will do when armed. */
  plan: string;
}
