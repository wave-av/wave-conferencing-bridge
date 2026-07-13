// native/src/ipc.cpp — see ../include/ipc.hpp for the contract this implements.
#include "ipc.hpp"

#include <iostream>

namespace wave::ipc {

namespace {

// Naive `"key":"value"` string-field extractor — good enough for the flat,
// fixed-shape messages this contract sends; NOT a general JSON parser.
// TODO(host): replace with a real JSON library (see ipc.hpp header note).
std::string extractString(const std::string& line, const std::string& key) {
  const std::string needle = "\"" + key + "\"";
  auto pos = line.find(needle);
  if (pos == std::string::npos) return "";
  pos = line.find(':', pos);
  if (pos == std::string::npos) return "";
  pos = line.find('"', pos);
  if (pos == std::string::npos) return "";
  auto end = line.find('"', pos + 1);
  if (end == std::string::npos) return "";
  return line.substr(pos + 1, end - pos - 1);
}

bool extractBool(const std::string& line, const std::string& key, bool fallback) {
  const std::string needle = "\"" + key + "\"";
  auto pos = line.find(needle);
  if (pos == std::string::npos) return fallback;
  return line.find("true", pos) != std::string::npos && line.find("true", pos) < line.find(',', pos) + 1;
}

int extractInt(const std::string& line, const std::string& key, int fallback) {
  const std::string needle = "\"" + key + "\"";
  auto pos = line.find(needle);
  if (pos == std::string::npos) return fallback;
  pos = line.find(':', pos);
  if (pos == std::string::npos) return fallback;
  try {
    return std::stoi(line.substr(pos + 1));
  } catch (...) {
    return fallback;
  }
}

}  // namespace

std::optional<JoinCommand> parseJoinCommand(const std::string& line) {
  if (line.find("\"cmd\"") == std::string::npos || line.find("\"join\"") == std::string::npos) {
    return std::nullopt;
  }
  JoinCommand cmd;
  cmd.signature = extractString(line, "signature");
  cmd.meetingNumber = extractString(line, "meetingNumber");
  cmd.passcode = extractString(line, "passcode");
  cmd.botDisplayName = extractString(line, "botDisplayName");
  cmd.videoUri = extractString(line, "uri");
  cmd.videoLoop = extractBool(line, "loop", true);
  cmd.videoFps = extractInt(line, "fps", 30);
  return cmd;
}

bool isLeaveCommand(const std::string& line) {
  return line.find("\"cmd\"") != std::string::npos && line.find("\"leave\"") != std::string::npos;
}

void emitReady() {
  std::cout << R"({"type":"ready"})" << std::endl;
}

void emitJoined(const std::string& captureId, const std::string& kind) {
  std::cout << R"({"type":"joined","captureId":")" << captureId << R"(","kind":")" << kind << R"("})" << std::endl;
}

void emitMediaFrame(long seq, long bytes) {
  std::cout << R"({"type":"media-frame","seq":)" << seq << R"(,"bytes":)" << bytes << "}" << std::endl;
}

void emitLeft() {
  std::cout << R"({"type":"left"})" << std::endl;
}

void emitError(const std::string& message) {
  std::cout << R"({"type":"error","message":")" << message << R"("})" << std::endl;
}

}  // namespace wave::ipc
