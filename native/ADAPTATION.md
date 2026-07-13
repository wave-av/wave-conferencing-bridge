# native/ — adapting `zoom/meetingsdk-headless-linux-sample` to WAVE's seams

Status: **INERT scaffold, host-gated.** This directory is a from-scratch,
faithful-structure recreation of the upstream sample's shape (it could not be
fetched in this environment) adapted to WAVE's task #88/M2 seams. Nothing here
compiles or runs on this (macOS) development machine by design — see
`HOST-REQUIREMENTS.md` for what an armed host needs.

## Why this exists

M2's TS scaffold (`../src/ingress/meeting-sdk-launch.ts`) defines a
`MeetingSdkJoinClient.join()` seam that must, on a real Linux bot host, drive
an actual Zoom Meeting SDK session: init → auth → join → external video
source → capture → leave. The Zoom Meeting SDK for Linux is a native (C++)
library — there is no pure-JS/WASM build — so that half of the driver has to
be a native binary, spawned and supervised by the TS adapter
(`../src/ingress/meeting-sdk-process-driver.ts`).

## Mapping: upstream sample → this scaffold

| Upstream (`meetingsdk-headless-linux-sample`) | This scaffold | Notes |
|---|---|---|
| `config.toml` (client id/secret, meeting join fields) | `config.toml.example` | Credential *names* only (`ZOOM_APPS_CLIENT_ID`/`ZOOM_APPS_CLIENT_SECRET`, from `DEFAULT_MEETING_SDK_CREDENTIAL_REF`); join fields arrive per-launch over IPC instead of the file, since WAVE launches N bots per farm, not one static config. |
| `main.cpp` (InitSDK → auth → CreateMeetingService → Join → run loop) | `src/main.cpp` | Same call sequence (marked `TODO(host)` at each SDK call); the run loop is driven by a `leave`-watcher thread instead of the sample's signal-handler-only exit, since WAVE's TS side controls the bot's lifecycle over stdio, not `Ctrl-C`. |
| Sample's `onAuthenticationReturn`/`onMeetingStatusChanged` callbacks | Same callback shape (`TODO(host)`), triggering `wave::ipc::emitReady()` / `emitJoined()` | The callbacks fire the IPC emits instead of printing to a log. |
| Custom `ZoomSDKVideoSource : public IZoomSDKVideoSource` (raw H.264/YUV frame injection) | `WaveLoopedVideoSource` (`include/wave_video_source.hpp` + `src/wave_video_source.cpp`) | Same registration point (`setExternalVideoSource`, called BEFORE `Join()`), same sender-push shape (`TODO(host)` for the actual `IZoomSDKVideoSender::sendVideoFrame` call); this version loops one clip (`LoopedVideoSource.uri`/`fps` from `../src/types/meeting-sdk.ts`) instead of a live camera passthrough. |
| Sample's raw-recording SDK (`IZoomSDKAudioRawDataDelegate`/`IZoomSDKRendererDelegate` for capture) | Not yet scaffolded — later ◆ | M2's `MeetingMediaCapture.kind` (`raw`\|`composited`) anticipates this; wiring the actual capture-side delegate is out of scope for this PR (transport + join lifecycle only). |
| `CMakeLists.txt` (links `libmeetingsdk.so`, includes SDK `h/`) | `CMakeLists.txt` | Same include/link shape, parameterized on `ZOOM_SDK_DIR` (env or `-D` flag) instead of a hardcoded path. |
| Sample's build README (SDK download + mount instructions) | `HOST-REQUIREMENTS.md` | WAVE-specific: pins the credential source, the flag that arms the TS side, and the exact host/OS/arch bar. |

## The stdio JSON-lines IPC contract

The native binary and the TS adapter (`ProcessMeetingSdkJoinClient` in
`../src/ingress/meeting-sdk-process-driver.ts`) speak line-delimited JSON over
stdin/stdout — one JSON object per line, no framing beyond `\n`. This keeps
the native binary a plain child process (no socket/port to manage, no extra
IPC library) and makes the contract trivially fake-able in TS unit tests
(`../src/ingress/meeting-sdk-process-driver.test.ts`).

```
 TS adapter                              native bot binary
 ───────────                              ─────────────────
 spawn(binaryPath) ─────────────────────▶ process starts
 write {"cmd":"join", signature,
        meetingNumber, passcode?,
        botDisplayName, video} ─────────▶ stdin: parseJoinCommand()
                                          InitSDK + auth (TODO host)
                            ◀───────────  stdout: {"type":"ready"}
                                          setExternalVideoSource (pre-join)
                                          IMeetingService::Join (TODO host)
                            ◀───────────  stdout: {"type":"joined",
                                                    captureId, kind}
                                          [join() in TS resolves here]
                            ◀ ─ ─ ─ ─ ─   stdout: {"type":"media-frame",
                                                    seq, bytes}  (periodic,
                                                    informational — TS
                                                    onMediaFrame sink)
 capture.stop() ─────────────────────────▶
 write {"cmd":"leave"} ──────────────────▶ stdin: isLeaveCommand()
                                          Leave + UninitSDK (TODO host)
                            ◀───────────  stdout: {"type":"left"}
                                          process exits
```

Error path: at ANY stage the native side may emit
`{"type":"error","message":"..."}` instead of the next expected message; the
TS adapter rejects `join()` with `MeetingSdkBotProcessError` on that, on an
unparseable message before `joined`, or on an unexpected process exit
(stderr tail included for diagnostics). A `joined`/`ready` that never arrives
within `joinTimeoutMs` (default 15s) rejects with `MeetingSdkBotTimeoutError`
and SIGTERMs the process.

## What's real vs. host-gated in THIS PR

- **Real (TS, tested, INERT by flag):** `ProcessMeetingSdkJoinClient` — the
  spawn/supervise/IPC-parse lifecycle; `createGatewayWhipPublisher` — the WHIP
  HTTP transport (request shaping, 201/Location parsing, DELETE teardown).
- **Host-gated (this directory):** every `TODO(host)` block — the actual Zoom
  Meeting SDK calls (`InitSDK`, auth, `Join`, `setExternalVideoSource`,
  `sendVideoFrame`, `Leave`, `UninitSDK`), and the video decode inside
  `WaveLoopedVideoSource::feedLoop`. None of this compiles without the SDK
  mounted (`ZOOM_SDK_DIR`) on an x86_64 Linux host.
