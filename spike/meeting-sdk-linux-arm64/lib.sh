#!/usr/bin/env bash
# lib.sh — shared constants + helpers for the arm64 Meeting SDK spike scripts.
# Sourced, not executed. Every path is absolute and derived from this file's dir.
# shellcheck disable=SC2034  # constants are consumed by the scripts that source this file

# --- pins (read from GitHub 2026-08-29; see README "Upstream facts") -------------
SAMPLE_REPO="https://github.com/zoom/meetingsdk-headless-linux-sample.git"
SAMPLE_SHA="c10031ec1b901494f30d1c6e7d075b6da3f83718"   # 2025-11-04 "updated comments"
SAMPLE_GLIBC_FLOOR="2.35"                                 # Ubuntu 22.04 = Zoom's documented prereq
VCPKG_ROOT="${VCPKG_ROOT:-/opt/vcpkg}"                    # sample CMakePresets.json hard-wires this

# --- layout -------------------------------------------------------------------
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SPIKE_DIR}/vendor/zoom-sdk"                 # gitignored; tarball lives here
SAMPLE_DIR="${SPIKE_DIR}/meetingsdk-headless-linux-sample" # gitignored clone
SDK_LIB_DIR="${SAMPLE_DIR}/lib/zoomsdk"                   # where the sample expects the SDK
BUILD_DIR="${SAMPLE_DIR}/build"
RECEIPTS_DIR="${SPIKE_DIR}/receipts"                      # gitignored
CONFIG_FILE="${SPIKE_DIR}/config.toml"                    # gitignored (holds the client secret)

RECEIPT=""

ts() { date -u +%Y%m%dT%H%M%SZ; }

receipt_open() {
  local name="${1:?receipt name}"
  mkdir -p "${RECEIPTS_DIR}"
  RECEIPT="${RECEIPTS_DIR}/${name}-$(ts).log"
  : > "${RECEIPT}"
  log "receipt: ${RECEIPT}"
}

log() {
  local line
  line="[$(ts)] $*"
  printf '%s\n' "${line}"
  if [[ -n "${RECEIPT}" ]]; then printf '%s\n' "${line}" >> "${RECEIPT}"; fi
}

die() {
  log "FAIL: $*"
  exit 1
}

# Print the newest arm64 tarball under VENDOR_DIR, or nothing.
find_sdk_tarball() {
  local f
  f="$(find "${VENDOR_DIR}" -maxdepth 1 -type f -name 'zoom-meeting-sdk-linux_arm64-*.tar*' 2>/dev/null | sort -V | tail -n1)"
  [[ -n "${f}" ]] && printf '%s\n' "${f}"
}
