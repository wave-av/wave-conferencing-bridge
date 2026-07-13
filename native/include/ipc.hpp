#pragma once
// native/include/ipc.hpp — stdio JSON-lines IPC for the headless bot.
//
// Implements the wire contract documented in ../ADAPTATION.md and mirrored by
// the TS side in ../../src/ingress/meeting-sdk-process-driver.ts. Kept
// dependency-free (no third-party JSON library) so this header/impl pair is
// reviewable without the Zoom SDK toolchain present.
//
// TODO(host): swap the hand-rolled parser below for a vetted JSON library
// (e.g. nlohmann/json) once the build toolchain is wired — the naive
// field-scan here is a stand-in, not a general JSON parser.

#include <optional>
#include <string>

namespace wave::ipc {

/** Fields carried by `{"cmd":"join", ...}` — mirrors MeetingSdkJoinParams (TS). */
struct JoinCommand {
  std::string signature;       // the HS256 JWT from meetingSdkJwt() — never the SDK secret
  std::string meetingNumber;
  std::string passcode;        // empty string if none
  std::string botDisplayName;
  std::string videoUri;        // LoopedVideoSource.uri
  bool videoLoop = true;
  int videoFps = 30;
};

/** Parses one stdin line as a join command. Returns nullopt if it isn't one. */
std::optional<JoinCommand> parseJoinCommand(const std::string& line);

/** True iff the line is `{"cmd":"leave"}`. */
bool isLeaveCommand(const std::string& line);

// Emitters — each writes ONE line-delimited JSON message to stdout + flushes,
// per the contract in ADAPTATION.md.
void emitReady();
void emitJoined(const std::string& captureId, const std::string& kind);
void emitMediaFrame(long seq, long bytes);
void emitLeft();
void emitError(const std::string& message);

}  // namespace wave::ipc
