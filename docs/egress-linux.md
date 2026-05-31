# Virtual camera + microphone — Linux

## Camera

**`v4l2loopback` kernel module** creates a `/dev/videoN` device that any
v4l2-capable app reads from. Standard pattern for Linux virtual cams (OBS,
Droidcam, etc.).

- Install: `apt install v4l2loopback-dkms` (or distro equivalent)
- Create device: `modprobe v4l2loopback video_nr=42 card_label="WAVE Broadcast"`
- Push frames: open `/dev/video42` for write; YUYV / I420 / RGB packed
- Zoom, Teams (Linux), Meet (in Edge / Chrome on Linux) all enumerate it

GPL-2 license; the WAVE userspace daemon talks to the kernel module via
the standard ioctl set, so the daemon itself can be MIT.

## Microphone

**PulseAudio null-sink + module-loopback** (or PipeWire equivalent on
modern distros) creates a virtual audio device. Apps pick it as a mic input.

- PulseAudio: `pactl load-module module-null-sink sink_name=wave_mic sink_properties=device.description=WAVE_Broadcast`
- PipeWire: `pw-loopback --capture-props "node.name=wave_mic"`

No kernel module needed; userspace only.

## Distro packaging

Ship as a `.deb` and `.rpm` plus a Flatpak. Flatpak handles v4l2loopback
sandboxing via `--device=video` permission.

## Roadmap (companion repo: wave-virtual-devices-linux)

| Wave | Surface |
|---|---|
| W1 | Userspace daemon: WAVE feed → /dev/video* writes |
| W2 | PulseAudio + PipeWire wiring |
| W3 | .deb / .rpm / Flatpak builds in CI |
| W4 | Wayland portal integration |
