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
    # glib dev headers: main.cpp runs a GMainLoop (the Meeting SDK for Linux is
    # glib-driven — libmeetingsdk.so NEEDs libglib-2.0/gio/gobject, confirmed
    # via objdump on 7.1.0.4100). Resolved through pkg-config in CMakeLists.txt.
    libglib2.0-dev \
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
    # Meeting SDK for Linux runtime deps — pinned from libmeetingsdk.so's
    # DT_NEEDED (objdump -p, SDK 7.1.0.4100). Qt6 libs are NOT apt-installed:
    # they ship in the SDK's qt_libs/ (copied below, on LD_LIBRARY_PATH) so the
    # bundled versions match. glib + X11/xcb + gbm/drm/GL/dbus/atomic here.
    libglib2.0-0 libatomic1 libdbus-1-3 \
    libx11-6 libxcb1 libxcb-xfixes0 libxcb-shape0 libxcb-shm0 libxcb-randr0 \
    libxcb-image0 libxcb-keysyms1 libxcb-xtest0 libxfixes3 \
    libgbm1 libdrm2 libgl1 \
    # Qt6 (from bundled qt_libs/) transitive deps surfaced by link + ldd:
    # libfontconfig1 (FcFontSetDestroy), libxkbcommon0 (xkb_state_serialize_layout),
    # libgssapi-krb5-2 (Qt6Network Kerberos), libegl1 (GL/EGL).
    libfontconfig1 libxkbcommon0 libgssapi-krb5-2 libegl1 \
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
# The SDK ships each lib as a bare *.so file, but their SONAMEs are versioned
# (libmeetingsdk.so.1, libmpg123.so.0 — confirmed via objdump), so the dynamic
# loader looks for those names. Symlink them (libcml.so's SONAME is unversioned,
# so it needs none).
RUN ln -sf libmeetingsdk.so /opt/wave/lib/libmeetingsdk.so.1 \
 && ln -sf libmpg123.so /opt/wave/lib/libmpg123.so.0
COPY --from=build /opt/zoom-meeting-sdk-linux/qt_libs/ ./lib/
# The bundled Qt6 libs are nested at qt_libs/Qt/lib/*.so.6 (confirmed on
# 7.1.0.4100), so after the COPY they sit at /opt/wave/lib/Qt/lib — that dir
# MUST be on LD_LIBRARY_PATH alongside the flat core libs in /opt/wave/lib.
ENV LD_LIBRARY_PATH=/opt/wave/lib:/opt/wave/lib/Qt/lib

COPY config.toml.example ./config.toml.example

# Credentials arrive via env under `doppler run` (ZOOM_APPS_CLIENT_ID /
# ZOOM_APPS_CLIENT_SECRET — see config.toml.example) — never baked into the
# image. The bot speaks stdio JSON-lines (see ../ADAPTATION.md); it is spawned
# by the TS process-driver adapter, not run standalone in production.
ENTRYPOINT ["./bin/wave_meeting_sdk_bot"]
