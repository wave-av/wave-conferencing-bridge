/**
 * Inbound shape: a conferencing app pushes its program stream into WAVE.
 * The shape is identical across apps (Zoom Pro RTMP, Teams Live Events RTMP,
 * Riverside Studio export RTMP, Squadcast RTMP). Differences live in the
 * per-app docs under ../../docs.
 */

import { z } from 'zod';

export const ConferencingAppSchema = z.enum([
  'zoom',
  'teams',
  'meet',
  'riverside',
  'squadcast',
]);
export type ConferencingApp = z.infer<typeof ConferencingAppSchema>;

export const RtmpIngressConfigSchema = z.object({
  app: ConferencingAppSchema,
  /** WAVE stream key issued by the gateway; the app's "Stream Key" input. */
  streamKey: z.string().min(8),
  /** App-side codec; we set the corresponding WAVE-side decoder. */
  codec: z.enum(['h264', 'hevc']),
  /** Optional bitrate hint, kbps. Drives the WAVE decoder buffer sizing. */
  bitrateKbpsHint: z.number().int().positive().optional(),
});
export type RtmpIngressConfig = z.infer<typeof RtmpIngressConfigSchema>;

export interface RtmpIngressBinding {
  /** Push-URL the conferencing app's "Stream URL" field accepts. */
  url: string;
  /** Stream key the app's "Stream Key" field accepts. */
  streamKey: string;
  /** WAVE feed slug the receiver will read from. */
  waveFeedSlug: string;
}
