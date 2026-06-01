# Virtual camera + microphone — Windows

## Camera

**Two options:**

1. **DirectShow filter (legacy, still common)** — register a COM CLSID with a `IBaseFilter` source that outputs RGB/I420 frames. Loaded by Win32 capture APIs. Zoom and Teams classic both speak DirectShow. Works since Windows XP.
2. **MediaFoundation source (modern path)** — implement `IMFActivate` + `IMFMediaSource`. UWP-friendly; consumed by `MediaCapture` API. Required by Teams (new) and Edge for `getUserMedia`. Microsoft sample: https://github.com/microsoft/Windows-Camera/tree/master/Samples/VirtualCamera

We ship **both**: DirectShow for backwards-compat, MediaFoundation for new Teams + Edge.

## Microphone

**Audio Endpoint via WASAPI loopback** + a kernel-mode driver (KMDF) for the virtual microphone endpoint. Apps see it as a regular mic input.

Microsoft sample: https://github.com/microsoft/Windows-driver-samples/tree/main/audio

Easier alternative: **Voicemeeter Banana / VB-CABLE pattern** — install a free third-party virtual audio cable, then push WAVE audio into its sink. Adds a runtime dep but removes the kernel-driver-signing burden.

## Signing

All Windows kernel drivers + system-level COM filters need:
- An EV code-signing certificate
- Cross-signed by Microsoft for kernel-mode (WHQL)
- Tested against current Win11 SmartScreen

CI is build-only; signed-artifact CI requires the EV cert (one shared HSM
per org). Tracked in `wave-virtual-devices-windows` companion repo.

## Roadmap (companion repo: wave-virtual-devices-windows)

| Wave | Surface |
|---|---|
| W1 | DirectShow source-filter scaffold (C++) |
| W2 | MediaFoundation virtual source scaffold |
| W3 | WASAPI virtual-mic endpoint |
| W4 | EV signing + Windows Store submission |
