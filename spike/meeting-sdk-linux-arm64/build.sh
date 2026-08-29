#!/usr/bin/env bash
# build.sh — configure + build the pinned headless sample on the Pi with its OWN CMake.
#
#   ./build.sh [--clean]
#
# Uses the sample's `debug` preset (CMakePresets.json -> /opt/vcpkg toolchain), which pulls
# cli11 / jwt-cpp / picojson via vcpkg.json. The sample's CMakeLists.txt `set()`s
# CMAKE_SYSTEM_PROCESSOR to x86_64 (informational — no cross toolchain is configured), so the
# native aarch64 g++ is what compiles; we still pass -DCMAKE_SYSTEM_PROCESSOR=aarch64 into
# the cache for the receipt. Everything is logged to receipts/build-<ts>.log.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

CLEAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

receipt_open "build"

[[ -d "${SAMPLE_DIR}/.git" ]] || die "sample not cloned — run prepare-pi.sh first"
[[ -f "${SDK_LIB_DIR}/libmeetingsdk.so" ]] || die "SDK not unpacked at ${SDK_LIB_DIR} — run prepare-pi.sh first"
[[ -f "${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake" ]] || die "vcpkg toolchain missing at ${VCPKG_ROOT} — run prepare-pi.sh first"
[[ "$(git -C "${SAMPLE_DIR}" rev-parse HEAD)" == "${SAMPLE_SHA}" ]] || die "sample drifted off the pinned sha ${SAMPLE_SHA}"

if [[ "${CLEAN}" -eq 1 && -d "${BUILD_DIR}" ]]; then
  log "clean: removing ${BUILD_DIR}"
  rm -rf "${BUILD_DIR}"
fi

export VCPKG_FORCE_SYSTEM_BINARIES=1   # required on arm64 Linux
log "toolchain: $(g++ --version | head -n1) | $(cmake --version | head -n1) | $(uname -m)"

CONFIGURE=(
  cmake -S "${SAMPLE_DIR}" -B "${BUILD_DIR}" --preset debug
  -DCMAKE_SYSTEM_PROCESSOR=aarch64
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
)
log "configure: ${CONFIGURE[*]}"
( cd "${SAMPLE_DIR}" && "${CONFIGURE[@]}" ) 2>&1 | tee -a "${RECEIPT}"

BUILD=( cmake --build "${BUILD_DIR}" --parallel "$(nproc)" )
log "build: ${BUILD[*]}"
"${BUILD[@]}" 2>&1 | tee -a "${RECEIPT}"

BIN="${BUILD_DIR}/zoomsdk"
[[ -x "${BIN}" ]] || die "binary not produced at ${BIN}"
log "binary: $(file -b "${BIN}")"
log "linked meetingsdk: $(ldd "${BIN}" | grep -E 'meetingsdk' || echo '(not in ldd output — check rpath)')"
log "DONE build — next: cp config.example.toml config.toml && chmod 600 config.toml && ./run-join.sh"
