# Spike — Zoom Meeting SDK for Linux (arm64) on a Raspberry Pi 5

Status: **HARNESS ONLY — nothing here has been run on a Pi yet.** This is the
Approach-C spike for the room endpoint: the Pi joins a Zoom meeting *natively*
(Meeting SDK, no browser) and, eventually, pushes raw I420 video from a UVC
camera into the meeting. It is the "Wave-2: add the Linux/headless SDK
dependency" lane of [`docs/ingress-zoom-meeting-sdk.md`](../../docs/ingress-zoom-meeting-sdk.md);
it does not change the design of record, it only proves (or disproves) that the
SDK builds and joins on aarch64.

## The gate — read before running anything

The Zoom Meeting SDK for Linux is **licence-gated and not in this repo**. The
harness expects the arm64 tarball at a gitignored path and fails loud if it is
missing:

```text
spike/meeting-sdk-linux-arm64/vendor/zoom-sdk/zoom-meeting-sdk-linux_arm64-<ver>.tar.xz
```

Get it from: **Zoom App Marketplace → your app (the WAVE General app whose
Client ID/Secret are `ZOOM_APPS_CLIENT_ID` / `ZOOM_APPS_CLIENT_SECRET` in
Doppler) → Features → Embed → Meeting SDK → Linux → Download**, pick the
**arm64** build (the download page says arm64 is supported "as of version
7.0.0"; the tarball naming pattern is `zoom-meeting-sdk-linux_<arch>-<ver>`).

**Never commit SDK bytes.** `vendor/`, the cloned sample, `receipts/` and the
real `config.toml` are all gitignored (see the repo `.gitignore`).

## What is in here

| File | Does |
|---|---|
| `prepare-pi.sh` | apt deps (from the sample's Dockerfile, with Trixie package-name fallbacks), vcpkg bootstrap, clone the sample at a **pinned sha**, unpack the tarball into `lib/zoomsdk`, `file` the `.so` to prove `aarch64`, print glibc vs the sample's floor |
| `build.sh` | `cmake` configure + build with the sample's own `CMakeLists.txt`/preset, logs to `receipts/` |
| `config.example.toml` | the sample's `config.toml` shape with placeholders only |
| `run-join.sh` | runs the sample with `config.toml`, tees the log, greps for the join status, writes a join receipt; optionally proves camera capture with a 10 s ffmpeg I420 grab |
| `sign-join-token.mjs` | prints a Meeting-SDK auth JWT from env via the repo's `meetingSdkJwt` signer (unit-tested in `sign-join-token.test.ts`) |

## Upstream facts this harness is built on (read 2026-08-29)

- Sample: <https://github.com/zoom/meetingsdk-headless-linux-sample>, pinned at
  `c10031ec1b901494f30d1c6e7d075b6da3f83718` (2025-11-04, "updated comments").
- The sample expects the SDK unpacked into `lib/zoomsdk` (README) and the
  binary links `-lmeetingsdk` from that dir; its `bin/entry.sh` also copies
  `libmeetingsdk.so` → `libmeetingsdk.so.1` before building.
- Deps (sample `Dockerfile`, `ubuntu:24.04`): build-essential, cmake, curl,
  git, libopencv-dev, libdbus-1-3, libgbm1, libgl1, libglib2.0-0/-dev,
  libssl-dev, libx11-dev, libx11-xcb1, libxcb-{image0,keysyms1,randr0,shape0,
  shm0,xfixes0,xtest0}, libgl1-mesa-dri, libxfixes3, linux-libc-dev, pciutils,
  pkgconf, tar, unzip, zip, libasound2t64 + alsa, pulseaudio; plus vcpkg with
  `cli11`, `jwt-cpp`, `picojson` (`vcpkg.json`) via the `debug` preset whose
  toolchain file is hard-wired to `/opt/vcpkg/scripts/buildsystems/vcpkg.cmake`.
- `CMakeLists.txt` requires CMake ≥ 3.22.1, C++20, and `set()`s
  `CMAKE_SYSTEM_PROCESSOR x86_64` — informational only (no cross toolchain), the
  native `g++` on the Pi is used. `build.sh` still passes `-DCMAKE_SYSTEM_PROCESSOR=aarch64`
  on the command line for the cache; the `set()` in the file wins for the
  variable, which does not affect codegen.
- Config: CLI11 config file. Top-level keys `client-id`, `client-secret`, and
  either `join-url` **or** `meeting-id` + `password`; optional `display-name`,
  `join-token` (an *App Privilege* token, NOT the SDK JWT), `zak`, `host`.
  Sections `[RawVideo] file=` / `[RawAudio] file=` enable raw **recording**
  (receive side) to `out/`.
- Raw video **send** (injection): the sample ships `src/raw_send/ZoomSDKVideoSource.*`
  (an `IZoomSDKVideoSource`), but the wiring (`GetRawdataVideoSourceHelper()->setExternalVideoSource(...)`
  and the unmute loop) is **commented out** in `src/Zoom.cpp::startRawRecording`.
  So: **the unpatched sample cannot inject camera video.** `run-join.sh` says so
  and only proves the capture leg (ffmpeg → I420 file) independently.
- The sample mints its own SDK auth JWT in `Zoom::generateJWT` from
  `client-id`/`client-secret` (HS256, `appKey`, `tokenExp`, 24 h). There is no
  flag to pass an externally minted SDK JWT. `sign-join-token.mjs` exists so the
  repo's server-side signer can be checked against the same credentials and is
  the token a later patch (`--sdk-jwt`) would consume; it is **not** consumed
  by the unpatched sample.
- Download page: <https://developers.zoom.us/docs/meeting-sdk/linux/get-started/download/>
  — arm64 "as of version 7.0.0"; prerequisites page still says CentOS 9 /
  Ubuntu 22 (x64). Cross-arch emulation (QEMU) is explicitly unsupported, so
  this must run on the Pi itself.
- Devforum (2026-08-29 read): #142384 cites `zoom-meeting-sdk-linux_arm64-6.7.5.7394`;
  #144540 runs 7.0.5.3529 on arm64; Zoom staff: raw **screen-share is broken on
  arm64 in 7.0.5**, audio/video OK.

## Steps (on the Pi 5, Raspberry Pi OS Bookworm or Trixie, aarch64)

```bash
# 0. clone this repo on the Pi, then drop the tarball in place
mkdir -p spike/meeting-sdk-linux-arm64/vendor/zoom-sdk
cp ~/Downloads/zoom-meeting-sdk-linux_arm64-*.tar.xz spike/meeting-sdk-linux-arm64/vendor/zoom-sdk/

# 1. deps + sample + SDK unpack + arch/glibc receipts
# (prepare-pi.sh chowns the workspace it writes back to $SUDO_USER on exit, so
# build.sh / run-join.sh below can run as your normal user)
sudo spike/meeting-sdk-linux-arm64/prepare-pi.sh

# 2. build
spike/meeting-sdk-linux-arm64/build.sh

# 3. config (never commit config.toml; it holds the client secret)
cp spike/meeting-sdk-linux-arm64/config.example.toml spike/meeting-sdk-linux-arm64/config.toml
chmod 600 spike/meeting-sdk-linux-arm64/config.toml
#    fill client-id / client-secret from Doppler:
#    doppler secrets get ZOOM_APPS_CLIENT_ID ZOOM_APPS_CLIENT_SECRET --project wave --config prd --plain

# 4. join (60 s window by default) and write the receipt
spike/meeting-sdk-linux-arm64/run-join.sh --timeout 60 --camera /dev/video0
```

Receipts land in `spike/meeting-sdk-linux-arm64/receipts/` (gitignored): copy
the relevant tails into the PR/issue when reporting.

Token check from the workstation (server-side signer, matches the sample's
claims shape plus `mn`/`role`):

```bash
npm run build   # sign-join-token.mjs imports dist/ on Node 22; src/*.ts on Node >= 23.6 / vitest
ZOOM_MEETING_NUMBER=12345678901 doppler run --project wave --config prd -- \
  node spike/meeting-sdk-linux-arm64/sign-join-token.mjs
```

## UNPROVEN (as of this commit)

1. That the arm64 tarball's `libmeetingsdk.so` loads on Raspberry Pi OS at all
   — glibc floor is unverified (Zoom's prereq page says Ubuntu 22 = glibc 2.35;
   Bookworm is 2.36, Trixie 2.41 — `prepare-pi.sh` prints both sides).
2. That the sample's Ubuntu-24.04 apt list resolves on Pi OS Trixie
   (`libglib2.0-0t64`, `libasound2t64` name drift handled by fallback; OpenCV
   dev on arm64 is large).
3. That vcpkg bootstraps and builds `cli11`/`jwt-cpp`/`picojson` on arm64
   (`VCPKG_FORCE_SYSTEM_BINARIES=1` is set for that).
4. That the SDK's Qt libs in `qt_libs/` run headless without a display on the Pi.
5. The join itself (auth → `MEETING_STATUS_INMEETING`).
6. Raw video injection from `/dev/video0` — requires un-commenting and finishing
   the `ZoomSDKVideoSource` wiring in the sample (out of scope for this harness).
7. Raw screen-share on arm64 — reported broken by Zoom in 7.0.5; not attempted.
