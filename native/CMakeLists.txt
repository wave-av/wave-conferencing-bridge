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

add_executable(wave_meeting_sdk_bot
  src/main.cpp
  src/wave_video_source.cpp
  src/ipc.cpp
)

target_include_directories(wave_meeting_sdk_bot PRIVATE
  include
  # TODO(host): the Zoom SDK's C++ headers (zoom_sdk.h, meeting_service_interface.h,
  # zoom_sdk_video_source_helper_interface.h, etc.) live under h/ in the SDK tree.
  "${ZOOM_SDK_DIR}/h"
)

# TODO(host): link the Zoom Meeting SDK's shared library (name/path per the
# distributed SDK — typically libmeetingsdk.so under qt_libs/ or a top-level
# lib/ dir; confirm against the SDK's own README once mounted).
target_link_directories(wave_meeting_sdk_bot PRIVATE "${ZOOM_SDK_DIR}/qt_libs" "${ZOOM_SDK_DIR}/lib")
target_link_libraries(wave_meeting_sdk_bot PRIVATE meetingsdk)

install(TARGETS wave_meeting_sdk_bot RUNTIME DESTINATION bin)
