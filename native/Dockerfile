# native/Dockerfile — headless Zoom Meeting-SDK bot image, task #88/M2.
#
# linux/amd64 ONLY: the Zoom Meeting SDK for Linux ships x86_64 binaries; there
# is no arm64 build (see ../HOST-REQUIREMENTS.md). Build with:
#   docker buildx build --platform linux/amd64 -t wave-meeting-sdk-bot:m2 native/
#
# HOST-GATED: this Dockerfile expects the Zoom Meeting SDK for Linux archive
# to be present at build context path `./zoom-meeting-sdk-linux/` (gitignored
# — never commit vendor SDK binaries; distribute per Zoom's license). Building
# WITHOUT that directory present will fail at the COPY step below by design —
# that failure is the fail-closed signal that this image was built off an
# unarmed host, not a broken Dockerfile.

FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config \
    # TODO(host): add whatever the Zoom Meeting SDK for Linux itself requires
    # at build/run time — per its README this has historically included Qt
    # runtime libs (libxcb*, libgl1, libdbus-1-3, libgbm1) and a decode lib
    # (e.g. ffmpeg/libavcodec) for WaveLoopedVideoSource. Confirm the exact
    # list against the SDK version actually mounted; do not guess at runtime.
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# The Zoom Meeting SDK for Linux tree (headers under h/, libs under qt_libs/ or
# lib/) — NOT vendored in this repo. Populate ./zoom-meeting-sdk-linux/ from
# your Zoom Marketplace download before building this image.
COPY zoom-meeting-sdk-linux/ /opt/zoom-meeting-sdk-linux/
ENV ZOOM_SDK_DIR=/opt/zoom-meeting-sdk-linux

COPY CMakeLists.txt ./
COPY include/ ./include/
COPY src/ ./src/

RUN cmake -B build -DZOOM_SDK_DIR=${ZOOM_SDK_DIR} && cmake --build build --config Release

FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    # TODO(host): the Meeting SDK for Linux runtime deps (see build stage
    # note above) must be installed here too — a static/self-contained build
    # would avoid this, but is not assumed.
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/wave

COPY --from=build /build/build/wave_meeting_sdk_bot ./bin/wave_meeting_sdk_bot
# Runtime shared libs. Observed SDK 7.1.0.4100 (see ADAPTATION.md): the core
# libs (libmeetingsdk/libcml/libmpg123) live at the SDK ROOT, the Qt runtime
# libs under qt_libs/. All must be on LD_LIBRARY_PATH for the bot to load.
COPY --from=build /opt/zoom-meeting-sdk-linux/libmeetingsdk.so \
     /opt/zoom-meeting-sdk-linux/libcml.so \
     /opt/zoom-meeting-sdk-linux/libmpg123.so ./lib/
COPY --from=build /opt/zoom-meeting-sdk-linux/qt_libs/ ./lib/
ENV LD_LIBRARY_PATH=/opt/wave/lib
# TODO(host, compile session): `ldd ./bin/wave_meeting_sdk_bot` on the armed
# host to confirm no unresolved Qt/xcb/gl/dbus/gbm .so remain (qt_libs/ may nest
# a Qt/ subdir not on the flat LD path) and pin any apt runtime deps above.

COPY config.toml.example ./config.toml.example

# Credentials arrive via env under `doppler run` (ZOOM_APPS_CLIENT_ID /
# ZOOM_APPS_CLIENT_SECRET — see config.toml.example) — never baked into the
# image. The bot speaks stdio JSON-lines (see ../ADAPTATION.md); it is spawned
# by the TS process-driver adapter, not run standalone in production.
ENTRYPOINT ["./bin/wave_meeting_sdk_bot"]
