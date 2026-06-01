# Virtual camera + microphone — macOS

Reference design for the macOS virtual-device drivers that present WAVE
feeds to Zoom / Teams / Meet as cameras + microphones.

## Camera

**Modern path (macOS Sonoma 14+): CMIO Extension**

Apple deprecated DAL-based CoreMediaIO plug-ins (the `/Library/CoreMediaIO/Plug-Ins/DAL/` path that NDI Tools, OBS Virtual Cam, etc. historically used). The new path is a `CMIOExtension` — a system extension bundled inside the host app's `.app` and registered via `CMIOExtensionProviderSource`.

Required entitlements:
- `com.apple.security.application-groups` (shared with host app)
- `com.apple.developer.system-extension.install`
- Camera & Microphone usage strings in the host's Info.plist

Apple sample: https://developer.apple.com/documentation/coremediaio/creating_a_camera_extension_with_core_media_io

**Legacy path (macOS 13 and below): DAL plug-in**

Bundle a `.plugin` containing a CMIO DAL implementation. Installed to `/Library/CoreMediaIO/Plug-Ins/DAL/wave-virtual-cam.plugin`. Still works as of macOS Sonoma but is on the deprecation timeline; do **not** ship to new customers.

Reference (community): https://github.com/johnboiles/obs-mac-virtualcam

## Microphone

**CoreAudio HAL plug-in**

Bundle a `.driver` exposing an `IOAudioFamily`-style HAL plug-in. Installed to `/Library/Audio/Plug-Ins/HAL/`. Apple-signed; requires kext entitlement (System Extension on Apple Silicon).

Alternative: **BlackHole / Loopback-style virtual audio device** + a userspace daemon that pushes WAVE audio samples into the BlackHole sink. Easier to ship (BlackHole is MIT-licensed) but adds a dependency for the operator.

Apple reference: https://developer.apple.com/library/archive/documentation/HardwareDrivers/Conceptual/HALOverview/

## Signing + notarization

All three paths require:
- An Apple Developer ID (Team)
- A Developer ID Application certificate
- Hardened-runtime enabled
- Notarization via `notarytool submit`

CI smoke tests cannot exercise camera/mic enumeration; integration tests
run on Jake's M2 dev box manually until we add a self-hosted runner.

## Roadmap (companion repo: wave-virtual-devices-macos)

| Wave | Surface |
|---|---|
| W1 | CMIO Extension scaffold (Swift + ObjC++) targeting Sonoma 14+ |
| W2 | CoreAudio HAL plug-in scaffold |
| W3 | Signing + notarization CI pipeline |
| W4 | Auto-update via Sparkle / Apple's MAU |
