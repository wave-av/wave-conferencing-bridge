// native/src/main.cpp — headless Zoom Meeting-SDK bot entrypoint, task #88/M2.
//
// HOST-GATED: requires the Zoom Meeting SDK for Linux (ZOOM_SDK_DIR) to compile
// and an x86_64 Linux host to run — see ../HOST-REQUIREMENTS.md.
//
// Drives the join→ready→media-frames→leave stdio JSON-lines IPC the TS
// process-driver speaks (../../src/ingress/meeting-sdk-process-driver.ts):
//   InitSDK → CreateAuthService → SDKAuth(jwt) → [glib main loop] →
//   onAuthenticationReturn → CreateMeetingService → register raw video source →
//   Join(without-login) → onMeetingStatusChanged(INMEETING) → emit "joined" →
//   feed looped video until {"cmd":"leave"} → Leave → CleanUPSDK.
//
// The Meeting SDK for Linux is glib-driven (its libmeetingsdk.so NEEDs
// libglib-2.0/gio/gobject — confirmed via objdump): SDK callbacks only dispatch
// while a GMainLoop is running, so main() runs g_main_loop_run() and all SDK
// calls happen on that loop thread. The stdin leave-watcher runs on its own
// thread and marshals back onto the loop via g_main_context_invoke.

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

#include <glib.h>

#include "ipc.hpp"
#include "wave_video_source.hpp"

#include "auth_service_interface.h"
#include "meeting_service_interface.h"
#include "rawdata/zoom_rawdata_api.h"
#include "zoom_sdk.h"
#include "zoom_sdk_def.h"

using namespace ZOOM_SDK_NAMESPACE;

namespace {

// Shared bot state, all touched only on the glib loop thread except `leaving`.
struct BotState {
  wave::ipc::JoinCommand join;
  IAuthService* authService = nullptr;
  IMeetingService* meetingService = nullptr;
  wave::WaveLoopedVideoSource* videoSource = nullptr;
  GMainLoop* loop = nullptr;
  bool joinedEmitted = false;
  bool terminalEmitted = false;  // an error/left line already went out
  std::atomic<bool> leaving{false};
};

BotState g_bot;

void quitLoop() {
  if (g_bot.loop != nullptr) g_main_loop_quit(g_bot.loop);
}

// Emit a terminal error exactly once, then note it so main()'s tail doesn't
// double-report.
void emitTerminalError(const std::string& message) {
  if (g_bot.terminalEmitted) return;
  g_bot.terminalEmitted = true;
  wave::ipc::emitError(message);
}

// Fires every 5s on the loop thread while in-meeting — informational media-frame
// heartbeat (seq = frames pushed by the video source so far).
gboolean heartbeatTick(gpointer) {
  if (g_bot.leaving.load()) return G_SOURCE_REMOVE;
  const long frames = g_bot.videoSource ? g_bot.videoSource->framesSent() : 0;
  wave::ipc::emitMediaFrame(frames, 0);
  return G_SOURCE_CONTINUE;
}

gboolean forceQuit(gpointer) {
  quitLoop();
  return G_SOURCE_REMOVE;
}

// Runs on the loop thread (scheduled from the stdin watcher): leave the meeting
// if in one, else quit directly. A short fallback timer forces quit if the
// ENDED status never arrives.
gboolean onLeaveRequested(gpointer) {
  if (g_bot.meetingService != nullptr) {
    g_bot.meetingService->Leave(LEAVE_MEETING);
    g_timeout_add(3000, forceQuit, nullptr);
  } else {
    quitLoop();
  }
  return G_SOURCE_REMOVE;
}

// Performs SDKAuth on the loop thread, once the glib main loop is running — the
// Linux SDK's service hub is only ready to accept auth after the loop pumps, so
// calling SDKAuth synchronously before g_main_loop_run() returns
// SDKERR_INTERNAL_ERROR (15). Scheduled via g_idle_add from main().
gboolean doAuth(gpointer);

class AuthEvent : public IAuthServiceEvent {
 public:
  void onAuthenticationReturn(AuthResult ret) override {
    if (ret != AUTHRET_SUCCESS) {
      emitTerminalError("SDK auth failed (AuthResult=" + std::to_string(static_cast<int>(ret)) + ")");
      quitLoop();
      return;
    }
    // Authenticated → create the meeting service and join.
    if (CreateMeetingService(&g_bot.meetingService) != SDKERR_SUCCESS || g_bot.meetingService == nullptr) {
      emitTerminalError("CreateMeetingService failed");
      quitLoop();
      return;
    }
    g_bot.meetingService->SetEvent(meetingEvent_);

    // Register the raw external video source BEFORE Join so the SDK routes our
    // frames instead of a real camera. Diagnostic escape hatch: WAVE_BOT_NO_VIDEO
    // skips the external source to isolate whether the raw-video media negotiation
    // is what tears down the meeting session before INMEETING.
    if (std::getenv("WAVE_BOT_NO_VIDEO") == nullptr) {
      IZoomSDKVideoSourceHelper* vhelper = GetRawdataVideoSourceHelper();
      if (vhelper == nullptr) {
        emitTerminalError("GetRawdataVideoSourceHelper returned null (rawdata not available)");
        quitLoop();
        return;
      }
      SDKError vset = vhelper->setExternalVideoSource(g_bot.videoSource, FrameDataFormat_I420_FULL);
      if (vset != SDKERR_SUCCESS) {
        emitTerminalError("setExternalVideoSource failed (SDKError=" + std::to_string(static_cast<int>(vset)) + ")");
        quitLoop();
        return;
      }
    } else {
      fprintf(stderr, "[diag] WAVE_BOT_NO_VIDEO set — skipping external video source\n");
      fflush(stderr);
    }

    const UINT64 mn = static_cast<UINT64>(std::strtoull(g_bot.join.meetingNumber.c_str(), nullptr, 10));

    if (!g_bot.join.zak.empty()) {
      // HOST-START via ZAK. Zoom's post-2026-03 policy ejects an unauthorized
      // guest Join (connect → immediate DISCONNECT → ENDED). Hosting the meeting
      // with the host's ZOOM access token is the sanctioned authorized path AND
      // needs no pre-existing host — the bot starts the meeting itself and is the
      // sole authorized participant, then publishes the external video source.
      StartParam sp;
      sp.userType = SDK_UT_WITHOUT_LOGIN;
      StartParam4WithoutLogin& s = sp.param.withoutloginStart;
      s.userZAK = g_bot.join.zak.c_str();
      s.userName = g_bot.join.botDisplayName.c_str();
      s.zoomuserType = ZoomUserType_EMAIL_LOGIN;  // ZAK is authoritative for identity
      s.meetingNumber = mn;
      s.isVideoOff = false;  // we publish video via the external source
      s.isAudioOff = true;   // bot sends no audio
      SDKError serr = g_bot.meetingService->Start(sp);
      if (serr != SDKERR_SUCCESS) {
        emitTerminalError("IMeetingService::Start failed (SDKError=" + std::to_string(static_cast<int>(serr)) + ")");
        quitLoop();
      }
    } else {
      // Guest Join (no ZAK) — works only for meetings that don't require an
      // authorized app join; kept for local/dev meetings.
      JoinParam jp;
      jp.userType = SDK_UT_WITHOUT_LOGIN;
      JoinParam4WithoutLogin& p = jp.param.withoutloginuserJoin;
      p.meetingNumber = mn;
      p.userName = g_bot.join.botDisplayName.c_str();
      p.psw = g_bot.join.passcode.empty() ? nullptr : g_bot.join.passcode.c_str();
      p.join_token = g_bot.join.joinToken.empty() ? nullptr : g_bot.join.joinToken.c_str();
      p.app_privilege_token = g_bot.join.appPrivilegeToken.empty() ? nullptr : g_bot.join.appPrivilegeToken.c_str();
      p.isVideoOff = false;
      p.isAudioOff = true;
      SDKError jerr = g_bot.meetingService->Join(jp);
      if (jerr != SDKERR_SUCCESS) {
        emitTerminalError("IMeetingService::Join failed (SDKError=" + std::to_string(static_cast<int>(jerr)) + ")");
        quitLoop();
      }
    }
  }
  void onLoginReturnWithReason(LOGINSTATUS, IAccountInfo*, LoginFailReason) override {}
  void onLogout() override {}
  void onZoomIdentityExpired() override {}
  void onZoomAuthIdentityExpired() override {}

  void setMeetingEvent(IMeetingServiceEvent* e) { meetingEvent_ = e; }

 private:
  IMeetingServiceEvent* meetingEvent_ = nullptr;
};

class MeetingEvent : public IMeetingServiceEvent {
 public:
  void onMeetingStatusChanged(MeetingStatus status, int iResult) override {
    // Diagnostic (stderr only — never on the stdout JSON protocol channel): surface
    // EVERY meeting-status transition so a silent join stall is observable. Zoom enum:
    // 0=IDLE 1=CONNECTING 2=WAITINGFORHOST 3=INMEETING 4=DISCONNECTING 5=RECONNECTING
    // 6=FAILED 7=ENDED 8=UNKNOWN 9=LOCKED 10=UNLOCKED 11=IN_WAITING_ROOM.
    fprintf(stderr, "[meeting-status] status=%d iResult=%d\n", static_cast<int>(status), iResult);
    fflush(stderr);
    switch (status) {
      case MEETING_STATUS_INMEETING:
        if (!g_bot.joinedEmitted) {
          g_bot.joinedEmitted = true;
          // captureId = the meeting number (the session handle the TS side keys on).
          wave::ipc::emitJoined(g_bot.join.meetingNumber, "composited");
          g_timeout_add_seconds(5, heartbeatTick, nullptr);
        }
        break;
      case MEETING_STATUS_FAILED:
        emitTerminalError("meeting join failed (MeetingFailCode=" + std::to_string(iResult) + ")");
        quitLoop();
        break;
      case MEETING_STATUS_ENDED:
        // main()'s tail emits the single "left"; here we only stop the loop.
        quitLoop();
        break;
      default:
        break;
    }
  }

  // Remaining IMeetingServiceEvent pure-virtuals — not needed by the bot, but
  // must be overridden for a concrete class (all no-ops).
  void onMeetingStatisticsWarningNotification(StatisticsWarningType) override {}
  void onMeetingParameterNotification(const MeetingParameter*) override {}
  void onSuspendParticipantsActivities() override {}
  void onAICompanionActiveChangeNotice(bool) override {}
  void onMeetingTopicChanged(const zchar_t*) override {}
  void onMeetingFullToWatchLiveStream(const zchar_t*) override {}
  void onUserNetworkStatusChanged(MeetingComponentType, ConnectionQuality, unsigned int, bool) override {}
  // onAppSignalPanelUpdated is #if defined(WIN32) only — not present on Linux.
};

gboolean doAuth(gpointer) {
  AuthContext authCtx;
  authCtx.jwt_token = g_bot.join.signature.c_str();
  authCtx.publicAppKey = nullptr;  // ensure the alternative-auth field is not garbage
  SDKError aerr = g_bot.authService->SDKAuth(authCtx);
  if (aerr != SDKERR_SUCCESS) {
    emitTerminalError("SDKAuth call rejected (SDKError=" + std::to_string(static_cast<int>(aerr)) + ")");
    quitLoop();
    return G_SOURCE_REMOVE;
  }
  wave::ipc::emitReady();
  return G_SOURCE_REMOVE;
}

// stdin watcher thread: blocks on getline; on {"cmd":"leave"} (or EOF/parent
// death) marshals a leave onto the loop thread.
void watchForLeave() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (wave::ipc::isLeaveCommand(line)) break;
  }
  g_bot.leaving.store(true);
  g_main_context_invoke(nullptr, onLeaveRequested, nullptr);
}

}  // namespace

int main() {
  // 1) Block for the TS adapter's {"cmd":"join", ...} on the FIRST stdin line.
  std::string line;
  if (!std::getline(std::cin, line)) {
    wave::ipc::emitError("stdin closed before a join command arrived");
    return 1;
  }
  auto join = wave::ipc::parseJoinCommand(line);
  if (!join) {
    wave::ipc::emitError("first stdin line was not a parseable join command");
    return 1;
  }
  g_bot.join = *join;

  // 2) InitSDK.
  InitParam initParam;
  initParam.strWebDomain = "https://zoom.us";
  initParam.strSupportUrl = "https://zoom.us";
  initParam.emLanguageID = LANGUAGE_English;
  initParam.enableLogByDefault = true;   // SDK writes diagnostic logs (auth failures etc.)
  initParam.enableGenerateDump = true;
  SDKError ierr = InitSDK(initParam);
  if (ierr != SDKERR_SUCCESS) {
    wave::ipc::emitError("InitSDK failed (SDKError=" + std::to_string(static_cast<int>(ierr)) + ")");
    return 1;
  }

  // 3) Auth with the pre-signed JWT (never the SDK secret — only the signature
  //    crosses the IPC boundary; see ../../src/ingress/meeting-sdk-jwt.ts).
  if (CreateAuthService(&g_bot.authService) != SDKERR_SUCCESS || g_bot.authService == nullptr) {
    wave::ipc::emitError("CreateAuthService failed");
    return 1;
  }
  static AuthEvent authEvent;
  static MeetingEvent meetingEvent;
  authEvent.setMeetingEvent(&meetingEvent);
  g_bot.authService->SetEvent(&authEvent);

  // Video source constructed now; the SDK owns its lifecycle once registered.
  wave::WaveLoopedVideoSource videoSource(g_bot.join.videoUri, g_bot.join.videoFps);
  g_bot.videoSource = &videoSource;

  // 4) Run the glib main loop: SDKAuth is deferred onto the loop (doAuth via
  //    g_idle_add) because the SDK service hub only accepts auth once the loop
  //    is pumping; SDK callbacks (auth return, meeting status) fire here and
  //    drive join → publish → leave. The stdin watcher marshals leave.
  g_bot.loop = g_main_loop_new(nullptr, FALSE);
  g_idle_add(doAuth, nullptr);
  std::thread leaveWatcher(watchForLeave);
  g_main_loop_run(g_bot.loop);

  // 5) Teardown.
  videoSource.onStopSend();
  if (g_bot.meetingService != nullptr) DestroyMeetingService(g_bot.meetingService);
  if (g_bot.authService != nullptr) DestroyAuthService(g_bot.authService);
  CleanUPSDK();

  if (!g_bot.terminalEmitted) {
    if (g_bot.joinedEmitted) {
      wave::ipc::emitLeft();
    } else {
      wave::ipc::emitError("bot exited before joining");
    }
    g_bot.terminalEmitted = true;
  }

  if (leaveWatcher.joinable()) {
    // Unblock the getline if stdin is still open.
    leaveWatcher.detach();
  }
  g_main_loop_unref(g_bot.loop);
  return 0;
}
