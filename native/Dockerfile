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
# Copy the FULL SDK runtime tree, not just the .so files. The Meeting SDK for
# Linux loads runtime RESOURCES (json/, imjs/, images/, new_home_page/, ...)
# from the directory containing libmeetingsdk.so at runtime — copying only the
# libs makes SDKAuth fail with SDKERR_INTERNAL_ERROR (15) even though the
# service hub initialises. Keeping the whole tree co-located fixes that.
COPY --from=build /opt/zoom-meeting-sdk-linux/ ./sdk/
# The SDK ships each lib as a bare *.so, but SONAMEs are versioned
# (libmeetingsdk.so.1, libmpg123.so.0 — objdump-confirmed); symlink them.
RUN ln -sf libmeetingsdk.so ./sdk/libmeetingsdk.so.1 \
 && ln -sf libmpg123.so ./sdk/libmpg123.so.0
# libmeetingsdk + the top-level libs live at ./sdk; the bundled Qt6 libs are
# nested at sdk/qt_libs/Qt/lib. Both must be on LD_LIBRARY_PATH.
ENV LD_LIBRARY_PATH=/opt/wave/sdk:/opt/wave/sdk/qt_libs/Qt/lib
# Run from the SDK dir so any cwd-relative resource lookups also resolve.
WORKDIR /opt/wave/sdk

COPY config.toml.example /opt/wave/config.toml.example

# Credentials arrive via env under `doppler run` (ZOOM_APPS_CLIENT_ID /
# ZOOM_APPS_CLIENT_SECRET — see config.toml.example) — never baked into the
# image. The bot speaks stdio JSON-lines (see ../ADAPTATION.md); it is spawned
# by the TS process-driver adapter, not run standalone in production.
# Absolute path: WORKDIR is /opt/wave/sdk (so the SDK finds cwd-relative
# resources) but the binary lives at /opt/wave/bin.
ENTRYPOINT ["/opt/wave/bin/wave_meeting_sdk_bot"]
