/**
 * Meeting-SDK headless-join launcher (Wave-2 of task #88/M2).
 *
 * This is the runtime the M2 scaffold gated on: given a bot (or farm) config it
 * signs the Meeting-SDK JWT (reusing `meeting-sdk-jwt.ts`), joins the Zoom
 * meeting via the injected headless client, meters the captured media through
 * the #91 media-tap seam, and republishes it to the WaveTarget's WHIP endpoint.
 *
 * DOUBLE-GATED + INERT BY DEFAULT. A join happens only when BOTH hold:
 *   1. the Wave-2 flag `ZOOM_MEETING_SDK_INGRESS_ENABLED` is ON (defaults OFF), and
 *   2. the Meeting-SDK credential env is present (`isMeetingSdkArmed`).
 * If either is false the launcher returns `planning-only` WITHOUT touching any
 * seam — no network, no credential read, no Zoom join. The scaffold already
 * models the credential gate; this file adds the flag gate on top and honors both.
 *
 * The real Zoom Meeting-SDK client + WHIP transport are a later ◆ — the default
 * seams here are INERT stubs that THROW if invoked, so even a mis-wired ON path
 * fails closed rather than silently reaching a live meeting.
 */

import { meetingSdkJwt, MEETING_SDK_MAX_TTL_SEC } from './meeting-sdk-jwt.js';
import { bindMeetingSdkIngress, isMeetingSdkArmed, planMeetingSdkBotFarm } from './meeting-sdk.js';
import {
  MeetingSdkBotConfigSchema,
  MeetingSdkBotFarmConfigSchema,
  type MeetingSdkBotBinding,
  type MeetingSdkBotConfig,
  type WaveTarget,
} from '../types/meeting-sdk.js';
import {
  isMeetingSdkIngressEnabled,
  type MediaTapMeter,
  type MeetingSdkCredentials,
  type MeetingSdkJoinClient,
  type MeetingSdkLaunchDeps,
  type MeetingSdkLaunchResult,
  type WhipPublisher,
} from '../types/meeting-sdk-launch.js';

const DEFAULT_TTL_SEC = 2 * 60 * 60; // 2h — well under the 48h Zoom max.

/**
 * Default media-tap meter: an in-memory byte counter. No network — it stands in
 * for the #91 one-subscribe surface so the launcher always has a meter to record
 * through even in tests. The real tap is injected in production.
 */
export function createInMemoryMediaTapMeter(): MediaTapMeter {
  const totals = new Map<string, number>();
  return {
    record(streamKey, bytes) {
      if (bytes < 0 || !Number.isFinite(bytes)) return;
      totals.set(streamKey, (totals.get(streamKey) ?? 0) + bytes);
    },
    total(streamKey) {
      return totals.get(streamKey) ?? 0;
    },
  };
}

/**
 * INERT default join client: throws. A real headless Meeting-SDK driver (Linux
 * bot-farm build) is a later ◆ and must be injected. Reaching this means the
 * flag was armed with no driver wired — fail closed, never touch a real meeting.
 */
export const inertJoinClient: MeetingSdkJoinClient = {
  join() {
    return Promise.reject(
      new Error(
        'meeting-sdk join: no headless Meeting-SDK driver injected — the native ' +
          'join client is a later ◆; refusing to reach a live meeting (INERT)',
      ),
    );
  },
};

/** INERT default WHIP publisher: throws. Real transport injected by a later ◆. */
export const inertWhipPublisher: WhipPublisher = {
  publish() {
    return Promise.reject(
      new Error(
        'whip publish: no WHIP transport injected — the wave-room publish path is ' +
          'a later ◆; refusing to emit bytes (INERT)',
      ),
    );
  },
};

/** Read credential VALUES from an already-armed env by their referenced names. */
function defaultResolveCredentials(
  env: NodeJS.ProcessEnv,
  keyEnv: string,
  secretEnv: string,
): MeetingSdkCredentials {
  const sdkKey = env[keyEnv];
  const sdkSecret = env[secretEnv];
  if (!sdkKey || !sdkSecret) {
    // Should be unreachable — the armed gate proved presence — but fail closed.
    throw new Error(`meeting-sdk launch: ${keyEnv}/${secretEnv} not present at launch`);
  }
  return { sdkKey, sdkSecret };
}

/** Effective TTL, clamped to the Zoom 48h maximum. */
function resolveTtlSec(deps: MeetingSdkLaunchDeps): number {
  const ttl = deps.ttlSec ?? DEFAULT_TTL_SEC;
  return Math.min(Math.max(1, Math.floor(ttl)), MEETING_SDK_MAX_TTL_SEC);
}

/**
 * Launch a single bot from its resolved binding + validated config. Assumes the
 * caller has already decided the pair is armed + enabled; performs the join,
 * meter, and republish, returning a `joined` result with stop handles.
 */
async function joinFromBinding(
  binding: MeetingSdkBotBinding,
  config: MeetingSdkBotConfig,
  waveTarget: WaveTarget,
  env: NodeJS.ProcessEnv,
  deps: MeetingSdkLaunchDeps,
): Promise<MeetingSdkLaunchResult> {
  const client = deps.client ?? inertJoinClient;
  const meter = deps.meter ?? createInMemoryMediaTapMeter();
  const publisher = deps.publisher ?? inertWhipPublisher;
  const resolveCredentials = deps.resolveCredentials ?? defaultResolveCredentials;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const { sdkKey, sdkSecret } = resolveCredentials(
    env,
    config.credentialRef.keyEnv,
    config.credentialRef.secretEnv,
  );

  const iat = now();
  const signature = meetingSdkJwt({
    sdkKey,
    sdkSecret,
    meetingNumber: config.meetingNumber,
    role: 0, // perception bots always join as attendees, never host
    iat,
    exp: iat + resolveTtlSec(deps),
  });

  const capture = await client.join({
    signature,
    meetingNumber: config.meetingNumber,
    passcode: config.passcode,
    botDisplayName: binding.botDisplayName,
    video: config.video,
  });

  // WHIP is the wave-native republish path (M1 parity). RTMP targets are the
  // operator (#90/M3) path and are not launched by the headless bot.
  if (waveTarget.mode !== 'whip') {
    await capture.stop();
    throw new Error(
      `meeting-sdk launch: headless bot republishes over WHIP; got waveTarget.mode='${waveTarget.mode}'`,
    );
  }

  // Meter the tapped media through the #91 seam before it is republished.
  meter.record(waveTarget.streamKey, capture.captureId.length);

  let publication;
  try {
    publication = await publisher.publish({
      whipUrl: waveTarget.whipUrl,
      streamKey: waveTarget.streamKey,
      capture,
    });
  } catch (err) {
    // Publish failed — never leak a joined capture; tear it down first.
    await capture.stop();
    throw err;
  }

  let stopped = false;
  return {
    status: 'joined',
    binding,
    waveTarget,
    capture,
    publication,
    async stop() {
      if (stopped) return;
      stopped = true;
      await publication.stop();
      await capture.stop();
    },
  };
}

/**
 * Launch one headless Meeting-SDK bot. Returns `planning-only` (touching NO
 * seam) unless the Wave-2 flag is ON *and* the credential is present.
 */
export async function launchMeetingSdkBot(
  raw: unknown,
  deps: MeetingSdkLaunchDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<MeetingSdkLaunchResult> {
  const config = MeetingSdkBotConfigSchema.parse(raw);
  const binding = bindMeetingSdkIngress(config, env);

  if (!isMeetingSdkIngressEnabled(env)) {
    return { status: 'planning-only', binding, reason: 'flag-off' };
  }
  if (!isMeetingSdkArmed(config, env)) {
    return { status: 'planning-only', binding, reason: 'credential-absent' };
  }
  return joinFromBinding(binding, config, config.waveTarget, env, deps);
}

/**
 * Launch a farm of N headless bots, honoring each bot's per-index join delay so
 * the farm doesn't thundering-herd the meeting. If the flag is OFF or the
 * credential is absent, EVERY bot returns `planning-only` and no delay is taken.
 */
export async function launchMeetingSdkBotFarm(
  raw: unknown,
  deps: MeetingSdkLaunchDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<MeetingSdkLaunchResult[]> {
  const farm = MeetingSdkBotFarmConfigSchema.parse(raw);
  const bindings = planMeetingSdkBotFarm(farm, env);
  const config = MeetingSdkBotConfigSchema.parse(farm.bot);

  const enabled = isMeetingSdkIngressEnabled(env);
  const armed = isMeetingSdkArmed(config, env);
  if (!enabled || !armed) {
    const reason = !enabled ? 'flag-off' : 'credential-absent';
    return bindings.map((binding) => ({ status: 'planning-only', binding, reason }));
  }

  const results: MeetingSdkLaunchResult[] = [];
  for (const binding of bindings) {
    if (binding.joinDelayMs > 0) await sleep(binding.joinDelayMs);
    results.push(await joinFromBinding(binding, config, config.waveTarget, env, deps));
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
