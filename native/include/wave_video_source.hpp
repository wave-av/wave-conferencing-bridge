#pragma once
// native/include/wave_video_source.hpp — custom looped video source, task #88/M2.
//
// TODO(host): the real Zoom Meeting SDK for Linux headers are required to
// compile this file. Once ZOOM_SDK_DIR/h is on the include path (see
// ../CMakeLists.txt), this class must actually inherit the SDK's video-source
// interface and be registered via `IMeetingVideoController::setExternalVideoSource()`
// BEFORE `IMeetingService::Join()` — the SDK routes external frames instead of
// a real camera only when the source is registered pre-join. Uncomment:
//   #include "zoom_sdk_def.h"
//   #include "meeting_service_components/meeting_video_interface.h"
//   #include "zoom_sdk_video_source_helper_interface.h"
// and change the class below to:
//   class WaveLoopedVideoSource : public ZOOM_SDK_NAMESPACE::IZoomSDKVideoSource { ... }
// implementing onInitialize / onPropertyChange / onStartSend / onStopSend /
// onUninitialized per the interface (see ADAPTATION.md for the exact mapping
// from the upstream sample's `ZoomSDKVideoSource` to this class).

#include <atomic>
#include <string>
#include <thread>

namespace wave {

/**
 * Feeds a looped, watermarked clip into the Meeting SDK as this bot's camera.
 * Mirrors `LoopedVideoSource` (../../src/types/meeting-sdk.ts): `uri` is the
 * clip path, `fps` bounds the feed rate. Deterministic + watermarked so
 * bot-farm media is self-identifying in the perception index (#85).
 */
class WaveLoopedVideoSource {
 public:
  WaveLoopedVideoSource(std::string loopPath, int fps);
  ~WaveLoopedVideoSource();

  WaveLoopedVideoSource(const WaveLoopedVideoSource&) = delete;
  WaveLoopedVideoSource& operator=(const WaveLoopedVideoSource&) = delete;

  // TODO(host): match IZoomSDKVideoSource::onStartSend()/onStopSend() exactly
  // — these are illustrative stand-ins for the lifecycle hooks the SDK calls
  // once this source is registered and the meeting is joined/left.
  void onStartSend();
  void onStopSend();

 private:
  void feedLoop();  // decodes loopPath_ on repeat, pushes frames while running_

  std::string loopPath_;
  int fps_;
  std::atomic<bool> running_{false};
  std::thread worker_;
  // TODO(host): ZOOM_SDK_NAMESPACE::IZoomSDKVideoSender* sender_ = nullptr;
  //   Captured in onInitialize(sender, ...); feedLoop() calls
  //   sender_->sendVideoFrame(buf, width, height, format, rotation) per
  //   decoded frame instead of the current no-op placeholder.
};

}  // namespace wave
