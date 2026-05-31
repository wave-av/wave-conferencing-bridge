/**
 * Ingress factory: given a conferencing-app config, returns the push-URL
 * shape the operator pastes into the app's "Live stream" settings.
 *
 * Today: stub that returns the WAVE gateway's documented RTMP base. Wave 2
 * wires this to the gateway's stream-key allocator + per-app auth handshake
 * (Zoom requires a one-time link-token; Teams uses a meeting-bound key).
 */

import {
  RtmpIngressConfigSchema,
  type RtmpIngressBinding,
  type RtmpIngressConfig,
} from '../types/ingress.js';

const WAVE_RTMP_BASE = process.env['WAVE_RTMP_BASE'] ?? 'rtmps://ingest.wave.online/live';

export function bindRtmpIngress(raw: unknown): RtmpIngressBinding {
  const config: RtmpIngressConfig = RtmpIngressConfigSchema.parse(raw);
  return {
    url: WAVE_RTMP_BASE,
    streamKey: config.streamKey,
    waveFeedSlug: deriveSlugFromStreamKey(config.streamKey),
  };
}

function deriveSlugFromStreamKey(streamKey: string): string {
  // Gateway-issued stream keys are formatted `live_<slug>_<sig>`. The slug
  // portion is the operator-facing identifier; everything else is opaque.
  const parts = streamKey.split('_');
  return parts[1] ?? streamKey;
}
