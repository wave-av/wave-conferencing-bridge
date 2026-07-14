// native/src/wave_video_source.cpp — see ../include/wave_video_source.hpp.
//
// Real IZoomSDKVideoSource implementation for SDK 7.1.0.4100. The SDK drives
// the lifecycle: onInitialize hands us the IZoomSDKVideoSender and a suggested
// capability (w/h/fps); onStartSend spins the feed thread; onStopSend /
// onUninitialized tear it down. feedLoop() generates a deterministic,
// self-identifying (watermarked) I420 frame each tick and pushes it via
// sender_->sendVideoFrame(buf, w, h, frameLength, rotation).
//
// Frames are GENERATED (not decoded from loopPath_): a moving luma bar over a
// fixed bot-signature chroma. This exercises the join->publish->RTMS->perception
// pipeline (#88/#85) with real motion the perception index can register, with
// no decode library in the image. TODO(follow-up): decode loopPath_ instead.

#include "wave_video_source.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

namespace wave {

using ZOOM_SDK_NAMESPACE::IList;
using ZOOM_SDK_NAMESPACE::IZoomSDKVideoSender;
using ZOOM_SDK_NAMESPACE::VideoSourceCapability;

WaveLoopedVideoSource::WaveLoopedVideoSource(std::string loopPath, int fps)
    : loopPath_(std::move(loopPath)), fps_(fps > 0 ? fps : 30) {}

WaveLoopedVideoSource::~WaveLoopedVideoSource() { onStopSend(); }

void WaveLoopedVideoSource::onInitialize(
    IZoomSDKVideoSender* sender,
    IList<VideoSourceCapability>* /*support_cap_list*/,
    VideoSourceCapability& suggest_cap) {
  sender_ = sender;
  if (suggest_cap.width > 0 && suggest_cap.height > 0) {
    width_.store(static_cast<int>(suggest_cap.width));
    height_.store(static_cast<int>(suggest_cap.height));
  }
  if (suggest_cap.frame > 0) fps_ = static_cast<int>(suggest_cap.frame);
}

void WaveLoopedVideoSource::onPropertyChange(
    IList<VideoSourceCapability>* /*support_cap_list*/,
    VideoSourceCapability suggest_cap) {
  if (suggest_cap.width > 0 && suggest_cap.height > 0) {
    width_.store(static_cast<int>(suggest_cap.width));
    height_.store(static_cast<int>(suggest_cap.height));
  }
  if (suggest_cap.frame > 0) fps_ = static_cast<int>(suggest_cap.frame);
}

void WaveLoopedVideoSource::onStartSend() {
  if (running_.exchange(true)) return;  // already running
  worker_ = std::thread(&WaveLoopedVideoSource::feedLoop, this);
}

void WaveLoopedVideoSource::onStopSend() {
  if (!running_.exchange(false)) return;  // already stopped
  if (worker_.joinable()) worker_.join();
}

void WaveLoopedVideoSource::onUninitialized() {
  onStopSend();
  sender_ = nullptr;
}

// Fill frame_ with an I420 frame: mid-gray luma with a bright vertical bar that
// sweeps left->right (motion signal), a fixed checker watermark in the top-left
// (self-identifying), and a constant bot-signature chroma (purple-ish hue).
void WaveLoopedVideoSource::renderFrame(long frameIdx) {
  const int w = width_.load();
  const int h = height_.load();
  const size_t ySize = static_cast<size_t>(w) * h;
  const size_t cSize = static_cast<size_t>(w / 2) * (h / 2);
  const size_t total = ySize + 2 * cSize;
  if (frame_.size() != total) frame_.assign(total, 0);

  auto* y = reinterpret_cast<uint8_t*>(frame_.data());
  auto* u = y + ySize;
  auto* v = u + cSize;

  // Luma: mid-gray background (128).
  std::memset(y, 128, ySize);

  // Moving vertical bar (bright, ~10% width) — the primary motion cue.
  const int barW = std::max(4, w / 10);
  const int barX = static_cast<int>((frameIdx * std::max(1, w / (fps_ > 0 ? fps_ : 30))) % w);
  for (int row = 0; row < h; ++row) {
    uint8_t* line = y + static_cast<size_t>(row) * w;
    for (int c = 0; c < barW; ++c) {
      int x = (barX + c) % w;
      line[x] = 235;  // near-white bar
    }
  }

  // Static checker watermark in the top-left (32x32, 8px cells) — deterministic
  // signature so bot-farm media is identifiable in the perception index (#85).
  const int wm = std::min(32, std::min(w, h));
  for (int row = 0; row < wm; ++row) {
    for (int col = 0; col < wm; ++col) {
      const bool on = ((row / 8) + (col / 8)) % 2 == 0;
      y[static_cast<size_t>(row) * w + col] = on ? 16 : 235;
    }
  }

  // Chroma: constant bot-signature hue with a slow cyclic shift so the color is
  // distinctive and gently animated. U~purple/blue, V~magenta.
  const uint8_t uu = static_cast<uint8_t>(96 + ((frameIdx / 30) % 16));
  const uint8_t vv = static_cast<uint8_t>(176 + ((frameIdx / 45) % 16));
  std::memset(u, uu, cSize);
  std::memset(v, vv, cSize);
}

void WaveLoopedVideoSource::feedLoop() {
  const int fps = fps_ > 0 ? fps_ : 30;
  const auto framePeriod = std::chrono::milliseconds(1000 / fps);
  long frameIdx = 0;
  auto next = std::chrono::steady_clock::now();
  while (running_.load()) {
    if (sender_ != nullptr) {
      renderFrame(frameIdx);
      const int w = width_.load();
      const int h = height_.load();
      const int frameLen = static_cast<int>(frame_.size());
      // rotation 0; format was fixed at registration (FrameDataFormat_I420_FULL).
      sender_->sendVideoFrame(frame_.data(), w, h, frameLen, 0);
      framesSent_.fetch_add(1);
    }
    ++frameIdx;
    next += framePeriod;
    std::this_thread::sleep_until(next);
  }
}

}  // namespace wave
