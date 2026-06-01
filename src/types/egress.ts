/**
 * Outbound shape: WAVE feeds expose themselves to the host OS as a virtual
 * camera + virtual microphone. Conferencing apps then pick them by name
 * (Zoom / Teams / Meet "WAVE Broadcast" in their device pickers).
 *
 * Driver implementations are platform-specific and live in companion
 * native repos (see ../../docs/egress-{macos,windows,linux}.md).
 */

import { z } from 'zod';

export const VirtualDeviceKindSchema = z.enum(['camera', 'microphone']);
export type VirtualDeviceKind = z.infer<typeof VirtualDeviceKindSchema>;

export const VirtualDeviceSpecSchema = z.object({
  kind: VirtualDeviceKindSchema,
  /** Name shown in the conferencing app's device picker. */
  name: z.string().min(1).max(64),
  /** WAVE feed slug whose frames/samples drive this device. */
  waveFeedSlug: z.string().min(1),
  /** Optional video shape; ignored for kind:'microphone'. */
  resolution: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().int().positive(),
    })
    .optional(),
  /** Optional audio shape; ignored for kind:'camera'. */
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
});
export type VirtualDeviceSpec = z.infer<typeof VirtualDeviceSpecSchema>;

export interface VirtualDeviceHandle {
  /** Opaque OS-level identifier (CMIO device-id / DirectShow CLSID / v4l2 path). */
  id: string;
  spec: VirtualDeviceSpec;
  /** True if the device is currently visible to apps. */
  active: boolean;
}
