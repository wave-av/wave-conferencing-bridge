# Contributing to wave-conferencing-bridge

## License

MIT. By contributing you agree your contributions are also MIT-licensed.

## License boundary

This repo defines **types + factories only**. Per-platform native drivers
live in:

- `wave-av/wave-virtual-devices-macos` (CMIO Extension + CoreAudio HAL)
- `wave-av/wave-virtual-devices-windows` (DirectShow + MediaFoundation + WASAPI)
- `wave-av/wave-virtual-devices-linux` (v4l2loopback userspace + PulseAudio/PipeWire)

Each of those repos has its own license posture appropriate to the
platform's driver-signing requirements. **Do not import** Apple / Microsoft
/ kernel-mode headers into this repo — those belong in the per-platform
companion repos.

## Dev setup

```sh
npm install
npm run type-check
npm run build
npm test
```

## PR shape

- Branch off `main`. Name: `feat/<thing>` or `fix/<thing>`.
- One concern per PR.
- Update `CHANGELOG.md`.

## Security

Open a private GitHub Security Advisory:
<https://github.com/wave-av/wave-conferencing-bridge/security/advisories/new>.
