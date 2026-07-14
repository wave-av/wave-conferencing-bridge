# native/CMakeLists.txt — task #88/M2 headless Zoom Meeting-SDK bot.
#
# HOST-GATED: this build requires the Zoom Meeting SDK for Linux binaries
# mounted at build time (see HOST-REQUIREMENTS.md). It is NOT expected to
# configure or build on this (macOS, arm64) development machine — that is by
# design; the TS scaffold + docs are the deliverable here, not a compiled
# binary. Adapted from the upstream `zoom/meetingsdk-headless-linux-sample`
# CMake shape (see ADAPTATION.md).

cmake_minimum_required(VERSION 3.16)
project(wave_meeting_sdk_bot CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# TODO(host): set to the mounted/extracted Zoom Meeting SDK for Linux tree,
# e.g. via `-DZOOM_SDK_DIR=/opt/zoom-meeting-sdk-linux` at configure time, or
# the ZOOM_SDK_DIR env var picked up below. The Dockerfile COPYs the SDK into
# this path before invoking cmake (see Dockerfile).
if(DEFINED ENV{ZOOM_SDK_DIR})
  set(ZOOM_SDK_DIR "$ENV{ZOOM_SDK_DIR}" CACHE PATH "Path to the Zoom Meeting SDK for Linux")
else()
  set(ZOOM_SDK_DIR "/opt/zoom-meeting-sdk-linux" CACHE PATH "Path to the Zoom Meeting SDK for Linux")
endif()

if(NOT EXISTS "${ZOOM_SDK_DIR}/h")
  message(WARNING
    "ZOOM_SDK_DIR (${ZOOM_SDK_DIR}) does not look like a Zoom Meeting SDK for Linux tree "
    "(expected a 'h/' headers dir under it). This is EXPECTED on a host without the SDK "
    "mounted — see native/HOST-REQUIREMENTS.md. Configure will proceed but the build will "
    "fail at the '#include <zoom_sdk.h>' TODO(host) markers until the SDK is present.")
endif()

# The Meeting SDK for Linux is glib-driven (libmeetingsdk.so NEEDs
# libglib-2.0/gio/gobject — confirmed via objdump on 7.1.0.4100); main.cpp runs
# a GMainLoop so SDK callbacks dispatch. Resolve glib via pkg-config.
find_package(PkgConfig REQUIRED)
pkg_check_modules(GLIB REQUIRED glib-2.0)

find_package(Threads REQUIRED)

add_executable(wave_meeting_sdk_bot
  src/main.cpp
  src/wave_video_source.cpp
  src/ipc.cpp
)

target_include_directories(wave_meeting_sdk_bot PRIVATE
  include
  # The Zoom SDK's C++ headers (zoom_sdk.h, meeting_service_interface.h,
  # rawdata/rawdata_video_source_helper_interface.h, etc.) live under h/.
  "${ZOOM_SDK_DIR}/h"
  ${GLIB_INCLUDE_DIRS}
)

# RESOLVED against observed SDK zoom-meeting-sdk-linux_x86_64-7.1.0.4100
# (2026-07-13, see ADAPTATION.md): libmeetingsdk.so lives at the SDK tree ROOT
# (${ZOOM_SDK_DIR}), NOT under qt_libs/ or a lib/ dir. Qt runtime libs are under
# qt_libs/. Both dirs are on the link path; the root supplies libmeetingsdk.so.
target_link_directories(wave_meeting_sdk_bot PRIVATE "${ZOOM_SDK_DIR}" "${ZOOM_SDK_DIR}/qt_libs")
target_link_libraries(wave_meeting_sdk_bot PRIVATE
  meetingsdk
  ${GLIB_LIBRARIES}
  Threads::Threads
)

install(TARGETS wave_meeting_sdk_bot RUNTIME DESTINATION bin)
