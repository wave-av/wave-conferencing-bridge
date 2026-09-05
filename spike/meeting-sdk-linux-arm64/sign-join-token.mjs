#!/usr/bin/env node
/**
 * sign-join-token.mjs — print a Zoom Meeting-SDK auth JWT from env using the repo's signer.
 *
 *   ZOOM_MEETING_NUMBER=12345678901 doppler run --project wave --config prd -- \
 *     node spike/meeting-sdk-linux-arm64/sign-join-token.mjs [--role 0|1] [--ttl-sec 3600]
 *
 * Env (names from src/types/meeting-sdk.ts DEFAULT_MEETING_SDK_CREDENTIAL_REF — there is NO
 * ZOOM_MEETING_SDK_* secret; the General app's client credentials ARE the SDK key/secret):
 *   ZOOM_APPS_CLIENT_ID      SDK Key
 *   ZOOM_APPS_CLIENT_SECRET  SDK Secret (used to sign only; never printed)
 *   ZOOM_MEETING_NUMBER      9-11 digit meeting number (the `mn` claim)
 *
 * Import note: `meetingSdkJwt` lives in src/ingress/meeting-sdk-jwt.ts and is NOT re-exported
 * from the package index (src/index.ts exports only the planners), so this is a DEEP import.
 * On Node 22 it resolves dist/ingress/meeting-sdk-jwt.js (run `npm run build` first); under
 * vitest, or Node >= 23.6 (type stripping), it falls back to the TS source directly.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST_URL = new URL('../../dist/ingress/meeting-sdk-jwt.js', import.meta.url);
const SRC_URL = new URL('../../src/ingress/meeting-sdk-jwt.ts', import.meta.url);

/** Resolve the repo signer: built dist first, TS source as the fallback. Exported for tests. */
export async function loadSigner() {
  if (existsSync(fileURLToPath(DIST_URL))) return import(DIST_URL.href);
  return import(SRC_URL.href);
}

/** Pure: env + clock → signer params. Throws on missing/invalid input; never touches the secret otherwise. */
export function paramsFromEnv(env, nowSec, { role = 0, ttlSec = 3600 } = {}) {
  const sdkKey = env.ZOOM_APPS_CLIENT_ID ?? '';
  const sdkSecret = env.ZOOM_APPS_CLIENT_SECRET ?? '';
  const meetingNumber = env.ZOOM_MEETING_NUMBER ?? '';
  if (!sdkKey) throw new Error('sign-join-token: ZOOM_APPS_CLIENT_ID is not set (run under `doppler run`)');
  if (!sdkSecret) throw new Error('sign-join-token: ZOOM_APPS_CLIENT_SECRET is not set (run under `doppler run`)');
  if (!/^\d{9,11}$/.test(meetingNumber)) throw new Error('sign-join-token: ZOOM_MEETING_NUMBER must be 9-11 digits');
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) throw new Error('sign-join-token: --ttl-sec must be a positive integer');
  const iat = Math.floor(nowSec);
  return { sdkKey, sdkSecret, meetingNumber, role, iat, exp: iat + ttlSec };
}

/** Parse argv → { role, ttlSec }. Exported for tests. */
export function parseArgs(argv) {
  const out = { role: 0, ttlSec: 3600 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--role') out.role = Number(argv[++i]);
    else if (a === '--ttl-sec') out.ttlSec = Number(argv[++i]);
    else if (a === '-h' || a === '--help') return { help: true };
    else throw new Error(`sign-join-token: unknown argument ${a}`);
  }
  if (out.role !== 0 && out.role !== 1) throw new Error('sign-join-token: --role must be 0 or 1');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('usage: sign-join-token.mjs [--role 0|1] [--ttl-sec N]  (reads ZOOM_APPS_CLIENT_ID/SECRET, ZOOM_MEETING_NUMBER)\n');
    return;
  }
  const { meetingSdkJwt } = await loadSigner();
  const params = paramsFromEnv(process.env, Date.now() / 1000, args);
  // stdout carries ONLY the token so it can be piped; nothing else is logged.
  process.stdout.write(`${meetingSdkJwt(params)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
