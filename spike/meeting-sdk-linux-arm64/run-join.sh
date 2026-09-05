#!/usr/bin/env bash
# run-join.sh — launch the built sample with config.toml, capture the join receipt.
#
#   ./run-join.sh [--timeout <sec>] [--camera /dev/videoN] [--no-pulse]
#
# What it proves / records (receipts/join-<ts>.log + receipts/join-<ts>.receipt):
#   * the sample's own log lines for auth + meeting status (grep: "joined", "authorize",
#     "MEETING_STATUS", "in meeting", "failed") with UTC timestamps,
#   * optionally a 10 s I420 grab from the UVC camera via ffmpeg (proves the CAPTURE leg only).
#
# Raw video INJECTION: the pinned sample ships ZoomSDKVideoSource (IZoomSDKVideoSource) but the
# wiring — GetRawdataVideoSourceHelper()->setExternalVideoSource(...) + unmute loop in
# src/Zoom.cpp::startRawRecording — is COMMENTED OUT upstream. There is NO flag to inject a
# camera frame stream. This script therefore does NOT pipe ffmpeg into the sample; it records the
# I420 grab to receipts/ so the camera side is proven independently. See README UNPROVEN #6.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

TIMEOUT_SEC=60
CAMERA=""
USE_PULSE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT_SEC="${2:?--timeout needs seconds}"; shift 2 ;;
    --camera) CAMERA="${2:?--camera needs a /dev/videoN path}"; shift 2 ;;
    --no-pulse) USE_PULSE=0; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "${TIMEOUT_SEC}" =~ ^[0-9]+$ ]] || die "--timeout must be an integer number of seconds"

receipt_open "join"
STAMP="$(basename "${RECEIPT}" .log)"
SUMMARY="${RECEIPTS_DIR}/${STAMP}.receipt"

BIN="${BUILD_DIR}/zoomsdk"
[[ -x "${BIN}" ]] || die "binary missing at ${BIN} — run build.sh first"
[[ -f "${CONFIG_FILE}" ]] || die "config missing at ${CONFIG_FILE} — cp config.example.toml config.toml && chmod 600 config.toml"
if grep -qE '<ZOOM_APPS_CLIENT_(ID|SECRET)>|<MEETING_NUMBER>' "${CONFIG_FILE}"; then
  die "config.toml still has placeholders — fill client-id / client-secret / meeting-id"
fi
PERM="$(stat -c %a "${CONFIG_FILE}" 2>/dev/null || echo '?')"
[[ "${PERM}" == "600" ]] || die "config.toml mode is ${PERM}; it holds the client secret — chmod 600 it"

# --- audio device: the sample's entry.sh needs a PulseAudio sink to exist ---------------
if [[ "${USE_PULSE}" -eq 1 ]]; then
  if command -v pactl >/dev/null && pactl info >/dev/null 2>&1; then
    pactl load-module module-null-sink sink_name=SpeakerOutput >/dev/null 2>&1 || true
    log "pulse: null sink SpeakerOutput ensured"
  else
    log "warn: pulseaudio not reachable (pactl info failed); SDK audio may not initialise (--no-pulse to silence)"
  fi
fi
mkdir -p "${HOME}/.config"
printf '[General]\nsystem.audio.type=default\n' > "${HOME}/.config/zoomus.conf"

# --- optional: prove the UVC capture leg with a 10 s I420 grab --------------------------
if [[ -n "${CAMERA}" ]]; then
  [[ -e "${CAMERA}" ]] || die "camera ${CAMERA} does not exist"
  CAP_OUT="${RECEIPTS_DIR}/${STAMP}-camera-i420-640x360.yuv"
  FFMPEG=(
    ffmpeg -hide_banner -loglevel error -y
    -f v4l2 -framerate 30 -video_size 640x360 -i "${CAMERA}"
    -t 10 -pix_fmt yuv420p -f rawvideo "${CAP_OUT}"
  )
  log "camera: ${FFMPEG[*]}"
  if "${FFMPEG[@]}" 2>>"${RECEIPT}"; then
    BYTES="$(stat -c %s "${CAP_OUT}")"
    # 640*360*1.5 = 345600 bytes per I420 frame
    log "camera: captured ${BYTES} bytes ≈ $(( BYTES / 345600 )) I420 frames in 10 s (PROVEN capture leg; injection into the SDK is NOT wired — see header)"
  else
    log "camera: ffmpeg grab FAILED (see receipt)"
  fi
fi

# --- run the sample ---------------------------------------------------------------------
export QT_LOGGING_RULES="*.debug=false;*.warning=false"
export LD_LIBRARY_PATH="${SDK_LIB_DIR}:${SDK_LIB_DIR}/qt_libs:${LD_LIBRARY_PATH:-}"
RUN=( "${BIN}" --config "${CONFIG_FILE}" )
log "run: timeout ${TIMEOUT_SEC}s :: ${BIN} --config ${CONFIG_FILE}"
START_EPOCH="$(date -u +%s)"
set +e
( cd "${SAMPLE_DIR}" && timeout --signal=INT --kill-after=10 "${TIMEOUT_SEC}" "${RUN[@]}" ) 2>&1 \
  | while IFS= read -r line; do printf '[%s] %s\n' "$(ts)" "${line}"; done | tee -a "${RECEIPT}"
RC="${PIPESTATUS[0]}"
set -e
END_EPOCH="$(date -u +%s)"

# --- receipt ---------------------------------------------------------------------------
{
  printf 'join receipt %s\n' "${STAMP}"
  printf 'host: %s | sample: %s | exit: %s (124 = timeout window elapsed) | wall: %ss\n' \
    "$(uname -m)" "${SAMPLE_SHA}" "${RC}" "$(( END_EPOCH - START_EPOCH ))"
  printf -- '--- status lines ---\n'
  grep -iE 'authoriz|joined|join|MEETING_STATUS|in meeting|inmeeting|raw recording|failed|error' "${RECEIPT}" || printf '(none matched)\n'
  printf -- '--- verdict ---\n'
  if grep -qiE 'MEETING_STATUS_INMEETING|joined|in meeting' "${RECEIPT}"; then
    printf 'JOINED: yes\n'
    JOINED=1
  else
    printf 'JOINED: no (no in-meeting status line seen within %ss)\n' "${TIMEOUT_SEC}"
    JOINED=0
  fi
  if [[ -n "${CAMERA}" ]]; then printf 'CAMERA CAPTURE: %sx proven, injection NOT wired\n' "$(grep -c 'PROVEN capture leg' "${RECEIPT}")"; fi
  printf 'raw recording out dir: %s/out\n' "${SAMPLE_DIR}"
} > "${SUMMARY}"

log "receipt summary: ${SUMMARY}"
cat "${SUMMARY}"
[[ "${JOINED}" -eq 1 ]] || exit 1
