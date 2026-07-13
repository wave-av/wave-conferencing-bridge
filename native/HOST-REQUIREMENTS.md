# native/ — host requirements to arm the M2 driver

This scaffold is INERT everywhere it isn't explicitly armed. Nothing here
runs until ALL of the following are true on the deploy host.

## 1. Host platform

- **x86_64 (amd64) Linux.** The Zoom Meeting SDK for Linux ships x86_64-only
  shared libraries — there is no arm64 build. `native/Dockerfile` is pinned
  `linux/amd64` for this reason; do not attempt to run the bot image on
  Apple-silicon Docker Desktop without QEMU emulation (functional but slow —
  fine for a one-off smoke test, not for production bot-farm load).
- A distro the SDK's own README certifies (historically Ubuntu/Debian-family;
  confirm against the SDK version actually downloaded — Zoom updates this
  per release).

## 2. Zoom Meeting SDK for Linux binaries

- Download from the Zoom Marketplace (Meeting SDK for Linux) under the WAVE
  Zoom Marketplace account. **Not vendored in this repo** — it's a licensed
  third-party binary distribution; `native/Dockerfile`'s `COPY
  zoom-meeting-sdk-linux/` step expects it staged in the build context and
  gitignored (see `.gitignore`).
- Mount/extract it to the path `ZOOM_SDK_DIR` points at (`CMakeLists.txt`
  defaults to `/opt/zoom-meeting-sdk-linux`; the Dockerfile's `COPY` stages it
  there too). The tree must contain a `h/` headers dir and the shared
  library (`qt_libs/` or `lib/`, per the SDK version — confirm against its own
  README before wiring `target_link_directories` for real).

## 3. Credentials — S2S / Meeting-SDK app config

- **App type:** a WAVE **General app** in the Zoom Marketplace (NOT a
  standalone "Meeting SDK" app — that class is deprecated by Zoom). The
  General app's **Client ID / Client Secret** double as the Meeting SDK's
  "SDK Key"/"SDK Secret" for JWT signing (see
  `../src/ingress/meeting-sdk-jwt.ts`).
- **Provisioned as:** `ZOOM_APPS_CLIENT_ID` / `ZOOM_APPS_CLIENT_SECRET` in
  Doppler (`wave/prd`) — already live, verified 2026-07-04 by public
  Client-ID match (see `../docs/ingress-zoom-meeting-sdk.md`). The bot reads
  these via `doppler run` at process start; they are never written to
  `config.toml` or this repo (see `../SECRETS.md`).
- **Scopes/config the General app needs for a live Meeting-SDK join:**
  - The app must have the **Meeting SDK** feature enabled (General apps gained
    Meeting-SDK JWT-signing capability when the standalone SDK-app class was
    deprecated) — confirm this toggle is on in the Marketplace app config
    before the first live join attempt.
  - No additional OAuth scopes are needed for the JWT join path itself (the
    join JWT is self-signed with the Client Secret, not an OAuth token) — but
    if a future wave also drives S2S calls (e.g. to look up meeting metadata
    via the Zoom REST API rather than just joining), that's a SEPARATE S2S
    OAuth app/credential and is out of scope for M2.

## 4. Arming the TS side

Two independent gates must BOTH be true (see
`../src/types/meeting-sdk-launch.ts` / `../docs/ingress-zoom-meeting-sdk.md`):

1. `ZOOM_MEETING_SDK_INGRESS_ENABLED` truthy (`1`/`true`/`yes`/`on`).
2. `MEETING_SDK_BOT_BINARY` set to the built binary's absolute path AND that
   path existing on disk (`../src/ingress/meeting-sdk-process-driver.ts`
   fails closed otherwise — `MeetingSdkBotUnavailableError`).

Absent either, every launch stays `planning-only` — no process is spawned, no
JWT is signed, no network call is made.

## 5. Build

```sh
docker buildx build --platform linux/amd64 -t wave-meeting-sdk-bot:m2 native/
# or, on an armed x86_64 Linux host directly:
cmake -S native -B native/build -DZOOM_SDK_DIR=/opt/zoom-meeting-sdk-linux
cmake --build native/build
```

Both paths fail at the `TODO(host)` `#include`/link lines until the SDK is
present — that failure is the intended fail-closed signal, not a scaffold bug.
