#pragma once
// native/include/wave_video_source.hpp — custom looped video source, task #88/M2.
//
// Real implementation of the Zoom Meeting SDK for Linux external raw-video
// source. Registered via GetRawdataVideoSourceHelper()->setExternalVideoSource()
// BEFORE IMeetingService::Join() (see main.cpp) — the SDK then drives this
// object's lifecycle: onInitialize (hands us the IZoomSDKVideoSender) ->
// onStartSend (we spin the feed thread) -> onStopSend/onUninitialized (we stop).
//
// Requires ZOOM_SDK_DIR/h on the include path (see ../CMakeLists.txt); does not
// compile without the SDK mounted on an x86_64 Linux host (../HOST-REQUIREMENTS.md).

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

#include "rawdata/rawdata_video_source_helper_interface.h"  // IZoomSDKVideoSource/Sender, VideoSourceCapability
#include "zoom_sdk_def.h"                                    // ZOOM_SDK_NAMESPACE, IList, FrameDataFormat

namespace wave {

/**
 * Feeds a deterministic, self-identifying (watermarked) I420 clip into the
 * Meeting SDK as this bot's camera. Mirrors `LoopedVideoSource`
 * (../../src/types/meeting-sdk.ts): `uri` names the intended clip, `fps` bounds
 * the feed rate. The frame content is generated (a moving watermark bar over a
 * bot-signature hue) rather than decoded from a file: for the #88/#85 pipeline
 * proof a generated I420 stream exercises the join->publish->RTMS->perception
 * path identically, without linking a decode library into the image.
 * TODO(follow-up): decode `loopPath_` (H.264/VP8) and loop it in place of the
 * generated pattern once a real clip asset is wired.
 */
class WaveLoopedVideoSource : public ZOOM_SDK_NAMESPACE::IZoomSDKVideoSource {
 public:
  WaveLoopedVideoSource(std::string loopPath, int fps);
  ~WaveLoopedVideoSource() override;

  WaveLoopedVideoSource(const WaveLoopedVideoSource&) = delete;
  WaveLoopedVideoSource& operator=(const WaveLoopedVideoSource&) = delete;

  // IZoomSDKVideoSource — exact signatures per SDK 7.1.0.4100 (note
  // onInitialize takes suggest_cap by reference, onPropertyChange by value).
  void onInitialize(
      ZOOM_SDK_NAMESPACE::IZoomSDKVideoSender* sender,
      ZOOM_SDK_NAMESPACE::IList<ZOOM_SDK_NAMESPACE::VideoSourceCapability>* support_cap_list,
      ZOOM_SDK_NAMESPACE::VideoSourceCapability& suggest_cap) override;
  void onPropertyChange(
      ZOOM_SDK_NAMESPACE::IList<ZOOM_SDK_NAMESPACE::VideoSourceCapability>* support_cap_list,
      ZOOM_SDK_NAMESPACE::VideoSourceCapability suggest_cap) override;
  void onStartSend() override;
  void onStopSend() override;
  void onUninitialized() override;

  /** Frames pushed since start — read by the IPC heartbeat in main.cpp. */
  long framesSent() const { return framesSent_.load(); }

 private:
  void feedLoop();                  // generates + pushes I420 frames while running_
  void renderFrame(long frameIdx);  // fills frame_ with the watermarked pattern

  std::string loopPath_;
  int fps_;

  ZOOM_SDK_NAMESPACE::IZoomSDKVideoSender* sender_ = nullptr;  // owned by SDK
  std::atomic<int> width_{1280};
  std::atomic<int> height_{720};
  std::vector<char> frame_;  // reusable I420 buffer (w*h*3/2)

  std::atomic<bool> running_{false};
  std::atomic<long> framesSent_{0};
  std::thread worker_;
};

}  // namespace wave
