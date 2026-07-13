// native/src/wave_video_source.cpp — see ../include/wave_video_source.hpp.
//
// TODO(host): the feed loop below is a placeholder timing/threading skeleton.
// The real implementation must decode `loopPath_` (H.264/VP8/raw-YUV per what
// the SDK's sendVideoFrame expects) and loop it, pushing each decoded frame to
// the SDK's IZoomSDKVideoSender at `fps_`. A media decode library (ffmpeg's
// libavcodec, or whatever the sample vendors) is required and is NOT present
// on this host — see HOST-REQUIREMENTS.md.

#include "wave_video_source.hpp"

#include <chrono>
#include <thread>

namespace wave {

WaveLoopedVideoSource::WaveLoopedVideoSource(std::string loopPath, int fps)
    : loopPath_(std::move(loopPath)), fps_(fps > 0 ? fps : 30) {}

WaveLoopedVideoSource::~WaveLoopedVideoSource() { onStopSend(); }

void WaveLoopedVideoSource::onStartSend() {
  if (running_.exchange(true)) return;  // already running
  worker_ = std::thread(&WaveLoopedVideoSource::feedLoop, this);
}

void WaveLoopedVideoSource::onStopSend() {
  if (!running_.exchange(false)) return;  // already stopped
  if (worker_.joinable()) worker_.join();
}

void WaveLoopedVideoSource::feedLoop() {
  const auto framePeriod = std::chrono::milliseconds(1000 / fps_);
  // TODO(host): open + decode loopPath_ here (loop the clip on EOF), and on
  // each iteration call sender_->sendVideoFrame(...) with the decoded frame.
  // This stub only paces a no-op loop so the threading/lifecycle shape is
  // reviewable without a decode library present.
  while (running_.load()) {
    std::this_thread::sleep_for(framePeriod);
  }
}

}  // namespace wave
