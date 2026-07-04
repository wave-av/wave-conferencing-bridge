/**
 * Meeting-SDK ingress factory (INERT scaffold — task #88/M2).
 *
 * Given a bot (or bot-farm) config, resolves the per-bot PLAN: what each
 * synthetic bot will do when it joins the Zoom meeting via the Meeting SDK and
 * republishes into WAVE. This mirrors the maturity of `bindRtmpIngress` — it is
 * a validated-shape stub. The actual Meeting-SDK join + media pull is Wave-2:
 * it adds the Zoom Meeting SDK dependency and is gated on the Meeting-SDK
 * credential (SDK Key/Secret) being present at launch.
 *
 * Nothing here reaches the network or reads a credential VALUE — it only checks
 * whether the named credential env vars are PRESENT, to report `armed`.
 */

import {
  MeetingSdkBotConfigSchema,
  MeetingSdkBotFarmConfigSchema,
  type MeetingSdkBotBinding,
  type MeetingSdkBotConfig,
} from '../types/meeting-sdk.js';

/**
 * True iff the Meeting-SDK credential env vars named by the config are both
 * present. Presence-only — the values are never read here. Absent => the
 * adapter stays inert (planning only, no Zoom join).
 */
export function isMeetingSdkArmed(
  config: MeetingSdkBotConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const { keyEnv, secretEnv } = config.credentialRef;
  return Boolean(env[keyEnv] && env[secretEnv]);
}

/** Resolve a single bot's plan. Index 0, no join delay. */
export function bindMeetingSdkIngress(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): MeetingSdkBotBinding {
  const config = MeetingSdkBotConfigSchema.parse(raw);
  return toBinding(config, 0, 0, env);
}

/**
 * Resolve the plan for every bot in a farm. Bots share one config; each gets a
 * unique display-name suffix and a staggered join delay so the farm doesn't
 * thundering-herd the meeting.
 */
export function planMeetingSdkBotFarm(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): MeetingSdkBotBinding[] {
  const farm = MeetingSdkBotFarmConfigSchema.parse(raw);
  return Array.from({ length: farm.count }, (_v, index) =>
    toBinding(farm.bot, index, index * farm.staggerMs, env),
  );
}

function toBinding(
  config: MeetingSdkBotConfig,
  index: number,
  joinDelayMs: number,
  env: NodeJS.ProcessEnv,
): MeetingSdkBotBinding {
  const requiredEnv = [config.credentialRef.keyEnv, config.credentialRef.secretEnv];
  const armed = isMeetingSdkArmed(config, env);
  // A farm gets per-bot names ("… 1", "… 2"); a single bot keeps its base name.
  const botDisplayName =
    index === 0 && joinDelayMs === 0
      ? config.botDisplayName
      : `${config.botDisplayName} ${index + 1}`;
  const plan = armed
    ? `join meeting ${config.meetingNumber} as "${botDisplayName}", present ` +
      `${config.video.uri} @${config.video.fps}fps, republish to WAVE via ` +
      `${config.waveTarget.mode}`
    : `INERT: ${requiredEnv.join(' + ')} not set — planning only, no Zoom join`;
  return {
    index,
    botDisplayName,
    meetingNumber: config.meetingNumber,
    waveTarget: config.waveTarget,
    video: config.video,
    requiredEnv,
    armed,
    joinDelayMs,
    plan,
  };
}
