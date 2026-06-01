/**
 * Egress factory: given a VirtualDeviceSpec, returns a handle representing
 * the registered OS-level device. The actual driver lifecycle (kext / CMIO
 * extension / DirectShow filter / v4l2loopback) lives in companion native
 * repos — this file only validates the spec + dispatches to the right
 * platform module at runtime.
 *
 * Today: stub returns an inactive handle. Wave 2 wires the platform modules.
 */

import {
  VirtualDeviceSpecSchema,
  type VirtualDeviceHandle,
  type VirtualDeviceSpec,
} from '../types/egress.js';

export function registerVirtualDevice(raw: unknown): VirtualDeviceHandle {
  const spec: VirtualDeviceSpec = VirtualDeviceSpecSchema.parse(raw);
  return {
    id: `wave-vd-${spec.kind}-${spec.waveFeedSlug}`,
    spec,
    active: false,
  };
}

export function platformDriverDocsUrl(): string {
  switch (process.platform) {
    case 'darwin':
      return 'https://github.com/wave-av/wave-conferencing-bridge/blob/main/docs/egress-macos.md';
    case 'win32':
      return 'https://github.com/wave-av/wave-conferencing-bridge/blob/main/docs/egress-windows.md';
    default:
      return 'https://github.com/wave-av/wave-conferencing-bridge/blob/main/docs/egress-linux.md';
  }
}
