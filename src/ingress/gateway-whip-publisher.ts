/**
 * Gateway WHIP publisher — task #88/M2 native driver, item 1.
 *
 * A real `WhipPublisher` (see `../types/meeting-sdk-launch.ts`) that speaks the
 * IETF WHIP handshake (draft-ietf-wish-whip-09) against the WAVE gateway's
 * `/v1/whip/publish` surface (proven live for audio; video connects to the same
 * SFU — see `wave-realtime-edge/src/whip.ts`):
 *
 *   POST   {whipUrl}                 (application/sdp offer) → 201 + SDP answer + Location
 *   DELETE {resolved Location}       → teardown (idempotent: 2xx or 404 both count as gone)
 *
 * AUTH mirrors the existing WAVE WHIP client (`wave-app/src/whip/whip-client.ts`):
 * the WaveTarget's gateway-issued `streamKey` IS the credential (SECRETS.md: "the
 * stream key is what carries the auth"), carried as `Authorization: Bearer
 * <streamKey>` — the gateway-trust auth header. `x-wave-room` lets multiple bots
 * targeting the same WaveTarget attach to one WAVE room for room-routed
 * recording (mirrors `wave-realtime-edge/src/whip-room.ts` WHIP_ROOM_HEADER).
 *
 * This module owns ONLY the WHIP HTTP transport (request shaping, answer
 * parsing, teardown) — real ICE/DTLS media negotiation needs a WebRTC stack,
 * which lives in the native Meeting-SDK bot process (see `native/`), not here.
 * The default `buildOfferSdp` emits a minimal, protocol-valid placeholder offer
 * so the HTTP transport is exercised end-to-end today; it is injectable so a
 * later ◆ can swap in the native driver's real SDP offer without touching this
 * class.
 *
 * SELECTION: this publisher is INERT by construction (no module-level state, no
 * network on import) but is only meant to be *selected* — via
 * `resolveWhipPublisher` — when `isMeetingSdkIngressEnabled(env)` is true. When
 * the flag is off, callers keep using `inertWhipPublisher` (throws), so a
 * mis-wired ON path still fails closed.
 */

import type {
  MeetingMediaCapture,
  WhipPublication,
  WhipPublishRequest,
  WhipPublisher,
} from '../types/meeting-sdk-launch.js';
import { isMeetingSdkIngressEnabled } from '../types/meeting-sdk-launch.js';
import { inertWhipPublisher } from './meeting-sdk-launch.js';

/** Header carrying the gateway-issued stream key as the publish credential. */
export const WHIP_AUTH_HEADER = 'authorization';
/** Header WAVE's realtime edge reads to route a publish into a specific room. */
export const WHIP_ROOM_HEADER = 'x-wave-room';

/** Thrown when the gateway responds to the WHIP offer with anything but 201. */
export class WhipPublishError extends Error {
  override readonly name = 'WhipPublishError';
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`whip publish: gateway responded ${status}: ${body.slice(0, 500)}`);
  }
}

/** Thrown when a 201 response is missing a required piece (Location, SDP body). */
export class WhipAnswerParseError extends Error {
  override readonly name = 'WhipAnswerParseError';
}

/** Thrown when a DELETE teardown fails with a non-2xx, non-404 status. */
export class WhipTeardownError extends Error {
  override readonly name = 'WhipTeardownError';
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`whip teardown: gateway responded ${status}: ${body.slice(0, 500)}`);
  }
}

/**
 * Minimal, protocol-valid WHIP offer: two m-lines (audio+video, both
 * recvonly-shaped placeholders) tagged with the capture id so the offer is
 * traceable to its native capture. Mirrors the shape the realtime edge already
 * accepts (`v=0` + CRLF-terminated — see `wave-realtime-edge/src/whip.ts`
 * §handlePublish's `/^v=0(\r?\n|\r)/` guard and its CRLF re-termination note).
 */
export function buildPlaceholderOfferSdp(capture: MeetingMediaCapture): string {
  const cname = capture.captureId.replace(/[^\w-]/g, '');
  return (
    `v=0\r\n` +
    `o=- ${Date.now()} 1 IN IP4 0.0.0.0\r\n` +
    `s=wave-meeting-sdk-bot\r\n` +
    `t=0 0\r\n` +
    `a=cname:${cname || 'meeting-sdk-bot'}\r\n` +
    `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` +
    `a=sendonly\r\n` +
    `m=video 9 UDP/TLS/RTP/SAVPF 96\r\n` +
    `a=sendonly\r\n`
  );
}

export interface GatewayWhipPublisherOptions {
  /** `fetch` implementation. Defaults to global `fetch`. Tests inject a mock — never hits the network. */
  fetch?: typeof fetch;
  /**
   * Builds the SDP offer for a capture. Defaults to {@link buildPlaceholderOfferSdp}. Real ICE/DTLS
   * negotiation is the native driver's concern (a later ◆); injectable so it can be swapped in later.
   */
  buildOfferSdp?: (capture: MeetingMediaCapture) => string;
  /** Derives the `x-wave-room` value from the publish request. Defaults to the WaveTarget's streamKey. */
  deriveRoom?: (req: WhipPublishRequest) => string | undefined;
}

/**
 * Real `WhipPublisher`: POSTs a WHIP SDP offer to `req.whipUrl` (the gateway
 * `/v1/whip/publish` surface), parses the 201 answer + `Location` into a
 * `WhipPublication`, and tears down via `DELETE` on `stop()`.
 */
export function createGatewayWhipPublisher(opts: GatewayWhipPublisherOptions = {}): WhipPublisher {
  const fetchImpl = opts.fetch ?? fetch;
  const buildOfferSdp = opts.buildOfferSdp ?? buildPlaceholderOfferSdp;
  const deriveRoom = opts.deriveRoom ?? ((req: WhipPublishRequest) => req.streamKey);

  return {
    async publish(req: WhipPublishRequest): Promise<WhipPublication> {
      const offerSdp = buildOfferSdp(req.capture);
      const room = deriveRoom(req);

      const headers: Record<string, string> = {
        'content-type': 'application/sdp',
        [WHIP_AUTH_HEADER]: `Bearer ${req.streamKey}`,
      };
      if (room) headers[WHIP_ROOM_HEADER] = room;

      const res = await fetchImpl(req.whipUrl, { method: 'POST', headers, body: offerSdp });

      if (res.status !== 201) {
        const body = await res.text().catch(() => '');
        throw new WhipPublishError(res.status, body);
      }

      const location = res.headers.get('location');
      if (!location) {
        throw new WhipAnswerParseError('whip publish: 201 response is missing the Location header');
      }
      const answerSdp = await res.text();
      if (!answerSdp.trim()) {
        throw new WhipAnswerParseError('whip publish: 201 response body is not a parseable SDP answer');
      }
      const resourceUrl = new URL(location, req.whipUrl).toString();

      let stopped = false;
      return {
        resourceUrl,
        async stop(): Promise<void> {
          if (stopped) return;
          stopped = true;
          const delRes = await fetchImpl(resourceUrl, {
            method: 'DELETE',
            headers: { [WHIP_AUTH_HEADER]: `Bearer ${req.streamKey}` },
          });
          if (!delRes.ok && delRes.status !== 404) {
            const body = await delRes.text().catch(() => '');
            throw new WhipTeardownError(delRes.status, body);
          }
        },
      };
    },
  };
}

/**
 * Selects the real gateway WHIP publisher only when the Wave-2 ingress flag is
 * ON; otherwise returns the INERT default (`inertWhipPublisher`, which throws).
 * Keeps "selected only when the flag is on" localized here rather than
 * defaulted inside `meeting-sdk-launch.ts`, so flag-off behavior there stays
 * byte-identical.
 */
export function resolveWhipPublisher(
  env: NodeJS.ProcessEnv = process.env,
  opts: GatewayWhipPublisherOptions = {},
): WhipPublisher {
  return isMeetingSdkIngressEnabled(env) ? createGatewayWhipPublisher(opts) : inertWhipPublisher;
}
