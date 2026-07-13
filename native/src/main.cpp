// native/src/main.cpp — headless Zoom Meeting-SDK bot entrypoint, task #88/M2.
//
// HOST-GATED: requires the Zoom Meeting SDK for Linux (ZOOM_SDK_DIR) to
// compile and an x86_64 Linux host to run — see ../HOST-REQUIREMENTS.md. Do
// NOT expect this to build here; it is not claimed to compile on this
// machine. Drives the join→ready→media-frames→leave stdio JSON-lines IPC the
// TS process-driver adapter speaks (../../src/ingress/meeting-sdk-process-driver.ts).
//
// TODO(host): once the SDK is mounted, replace every TODO(host) block below
// with real Meeting SDK calls: InitSDK -> auth using the JWT the TS side
// signs and sends in the join command -> IMeetingService::Join ->
// setExternalVideoSource binding a WaveLoopedVideoSource (registered BEFORE
// Join, per the SDK's requirement) -> pump the SDK's event loop until leave.

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>

#include "ipc.hpp"
#include "wave_video_source.hpp"

// TODO(host): #include "zoom_sdk.h", "auth_service_interface.h",
// "meeting_service_interface.h", "meeting_service_components/meeting_video_interface.h"
// once ZOOM_SDK_DIR/h is on the include path (see ../CMakeLists.txt).

namespace {

/** Watches stdin for `{"cmd":"leave"}` on a dedicated thread and flips `leaving` when seen. */
void watchForLeave(std::atomic<bool>& leaving) {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (wave::ipc::isLeaveCommand(line)) {
      leaving.store(true);
      return;
    }
  }
  // stdin closed without an explicit leave (e.g. parent process died) — treat as leave too,
  // so the bot never spins forever with a gone supervisor.
  leaving.store(true);
}

}  // namespace

int main() {
  std::string line;

  // 1) join: block for the TS adapter's {"cmd":"join", ...} on the FIRST stdin line.
  if (!std::getline(std::cin, line)) {
    wave::ipc::emitError("stdin closed before a join command arrived");
    return 1;
  }
  auto join = wave::ipc::parseJoinCommand(line);
  if (!join) {
    wave::ipc::emitError("first stdin line was not a parseable join command");
    return 1;
  }

  // TODO(host): InitSDK(initParam), then authenticate using join->signature
  // (the HS256 JWT already signed by meetingSdkJwt() on the TS side — see
  // ../../src/ingress/meeting-sdk-jwt.ts). NEVER derive or hold the SDK
  // secret here; only the pre-signed signature crosses the IPC boundary.
  wave::ipc::emitReady();

  // Register the custom video source BEFORE Join() — the Meeting SDK for
  // Linux only routes external frames instead of a real camera when the
  // source is set pre-join (see ../include/wave_video_source.hpp).
  wave::WaveLoopedVideoSource videoSource(join->videoUri, join->videoFps);
  // TODO(host): meetingVideoController->setExternalVideoSource(&videoSource);

  // TODO(host): IMeetingService::Join(joinParam) built from join->meetingNumber,
  // join->passcode, join->botDisplayName. On the SDK's
  // onMeetingStatusChanged(MEETING_STATUS_INMEETING) callback, call
  // videoSource.onStartSend() and THEN emit "joined" (captureId = the SDK's
  // session/renderer handle id; kind = "composited" | "raw" per config.toml).
  videoSource.onStartSend();
  const std::string captureId = "TODO-host-session-handle";
  wave::ipc::emitJoined(captureId, "composited");

  // 2) media-frames + leave: heartbeat while a dedicated thread watches stdin
  // for the leave command (kept off the SDK's own pump thread so a slow/blocked
  // read never stalls meeting processing).
  std::atomic<bool> leaving{false};
  std::thread leaveWatcher(watchForLeave, std::ref(leaving));

  long seq = 0;
  while (!leaving.load()) {
    // TODO(host): drive the Zoom SDK's message loop tick here — the Linux SDK
    // requires the host app to pump it periodically (see the upstream
    // sample's main loop, ADAPTATION.md §event loop). This stub only
    // heartbeats on a timer.
    std::this_thread::sleep_for(std::chrono::seconds(5));
    if (!leaving.load()) wave::ipc::emitMediaFrame(seq++, 0);
  }
  if (leaveWatcher.joinable()) leaveWatcher.join();

  // TODO(host): videoSource.onStopSend() already covered by its destructor;
  // still call IMeetingService::Leave() and UninitSDK() here before exit.
  videoSource.onStopSend();
  wave::ipc::emitLeft();
  return 0;
}
