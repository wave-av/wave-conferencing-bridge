# wave-conferencing-bridge

Bidirectional bridge between WAVE feeds and conferencing apps (Zoom, Microsoft Teams, Google Meet, Riverside, Squadcast).

Layer 0 of the [WAVE Protocol Plane][plane].

## What's in the box

This is the **architectural-spec** repo. Per-platform native drivers (CMIO extensions / DirectShow filters / v4l2loopback userspace daemons) live in companion repos that consume the types defined here.

| Direction | Today's surface | Wave 2 deliverable |
|---|---|---|
| **Ingress** (App → WAVE) | `bindRtmpIngress(config)` factory returning `{ url, streamKey, waveFeedSlug }` | Real gateway integration; per-app auth handshakes |
| **Egress** (WAVE → App) | `registerVirtualDevice(spec)` factory returning a handle | Per-platform driver companion repos (`wave-virtual-devices-{macos,windows,linux}`) |

## Coverage matrix

| App | Ingress (App → WAVE) | Egress (WAVE → App as virtual cam/mic) |
|---|---|---|
| **Zoom Pro** | ✅ RTMP — `bindRtmpIngress({ app: 'zoom', ... })` | ✅ Virtual cam visible in Zoom device picker |
| **Microsoft Teams** | ✅ RTMP (Teams Live Events) | ✅ Same |
| **Google Meet** | ❌ Meet has no RTMP — route via OBS plugin | ✅ Same |
| **Riverside** | ✅ RTMP | ✅ Same |
| **Squadcast** | ✅ RTMP | ✅ Same |

## Platform-specific docs

- [macOS — CMIO Extension + CoreAudio HAL](./docs/egress-macos.md)
- [Windows — DirectShow + MediaFoundation + WASAPI](./docs/egress-windows.md)
- [Linux — v4l2loopback + PulseAudio/PipeWire](./docs/egress-linux.md)

## Usage

```ts
import { bindRtmpIngress, registerVirtualDevice } from '@wave-av/conferencing-bridge';

// Ingress — paste these into Zoom's Live Stream settings
const { url, streamKey } = bindRtmpIngress({
  app: 'zoom',
  streamKey: 'live_yourshow_xxxxxxxxxxxxxxxx',
  codec: 'h264',
});

// Egress — register a virtual camera that pulls from a WAVE feed
const cam = registerVirtualDevice({
  kind: 'camera',
  name: 'WAVE Broadcast',
  waveFeedSlug: 'yourshow',
  resolution: { width: 1920, height: 1080, fps: 30 },
});
```

## License

[MIT](./LICENSE). No vendor-licensed assets in this repo; per-platform
native drivers in companion repos may have their own license posture
(v4l2loopback is GPL-2; CMIO extensions are Apple-blessed; DirectShow
filters are Microsoft-blessed and ship under our MIT).

[plane]: https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md
