#!/usr/bin/env bash
# prepare-pi.sh — prepare a Raspberry Pi 5 (aarch64, Raspberry Pi OS Bookworm/Trixie)
# to build zoom/meetingsdk-headless-linux-sample against the arm64 Meeting SDK.
#
#   sudo ./prepare-pi.sh [--skip-apt] [--sdk-tarball <path>]
#
# What it does (each step writes a receipt line to receipts/prepare-<ts>.log):
#   1. apt deps — the list from the sample's Dockerfile (ubuntu:24.04), with Debian
#      Trixie/Bookworm package-name fallbacks (t64 transition).
#   2. vcpkg bootstrap at /opt/vcpkg (the sample's CMakePresets.json hard-wires
#      /opt/vcpkg/scripts/buildsystems/vcpkg.cmake). VCPKG_FORCE_SYSTEM_BINARIES=1
#      is required on arm64.
#   3. clone the sample at the PINNED sha (no floating main).
#   4. unpack the licence-gated SDK tarball (vendor/zoom-sdk/, gitignored) into
#      <sample>/lib/zoomsdk — fail loud with download instructions if absent.
#   5. `file` libmeetingsdk.so to prove aarch64; print glibc vs the sample's floor.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

SKIP_APT=0
SDK_TARBALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-apt) SKIP_APT=1; shift ;;
    --sdk-tarball) SDK_TARBALL="${2:?--sdk-tarball needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

receipt_open "prepare"

# ---------------------------------------------------------------- 0. host facts
ARCH="$(uname -m)"
log "host: $(uname -srm)"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  log "os: $(. /etc/os-release && printf '%s %s (%s)' "${NAME:-?}" "${VERSION:-?}" "${VERSION_CODENAME:-?}")"
fi
[[ "${ARCH}" == "aarch64" ]] || die "this harness is for aarch64 only (got ${ARCH}); Zoom says cross-arch emulation is unsupported"

# ---------------------------------------------------------------- 1. apt deps
# Source: meetingsdk-headless-linux-sample/Dockerfile @ ${SAMPLE_SHA} (ubuntu:24.04).
# Pi OS Trixie is Debian 13; the t64 names match Ubuntu 24.04. Bookworm (Debian 12)
# predates the t64 transition, hence the fallbacks.
APT_BASE=(
  build-essential ca-certificates cmake curl gdb git gfortran
  libopencv-dev libdbus-1-3 libgbm1 libgl1 libglib2.0-dev
  libssl-dev libx11-dev libx11-xcb1
  libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-shape0 libxcb-shm0
  libxcb-xfixes0 libxcb-xtest0 libgl1-mesa-dri libxfixes3
  linux-libc-dev pciutils pkgconf tar unzip zip
  alsa-utils pulseaudio pulseaudio-utils
  file ffmpeg v4l-utils
)
# name-drift pairs: first that resolves wins
APT_ALTS=(
  "libglib2.0-0t64|libglib2.0-0"
  "libasound2t64|libasound2"
  "libasound2-plugins|"
)

if [[ "${SKIP_APT}" -eq 0 ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "apt step needs root: re-run with sudo (or --skip-apt)"
  log "apt-get update"
  apt-get update -qq
  pkgs=("${APT_BASE[@]}")
  for alt in "${APT_ALTS[@]}"; do
    picked=""
    IFS='|' read -r -a candidates <<< "${alt}"
    for c in "${candidates[@]}"; do
      [[ -n "${c}" ]] || continue
      if apt-cache show "${c}" >/dev/null 2>&1; then picked="${c}"; break; fi
    done
    if [[ -n "${picked}" ]]; then
      pkgs+=("${picked}")
      log "apt alt: ${alt} -> ${picked}"
    else
      log "apt alt: ${alt} -> (none available; skipping)"
    fi
  done
  log "apt-get install (${#pkgs[@]} packages)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}"
else
  log "apt step skipped (--skip-apt)"
fi

CMAKE_VER="$(cmake --version | head -n1)"
log "cmake: ${CMAKE_VER} (sample floor: 3.22.1)"

# Fetch a pinned sha into a repo clone (cloning first if absent) and detach onto it.
# Only fetches when the sha is not already present locally, and fails loud (via die)
# rather than letting a swallowed fetch error surface as a raw git-checkout error.
checkout_pinned_sha() {
  local repo="${1:?repo url}" dir="${2:?dir}" sha="${3:?sha}"
  if [[ ! -d "${dir}/.git" ]]; then
    log "cloning ${repo} -> ${dir}"
    git clone --quiet "${repo}" "${dir}"
  fi
  if ! git -C "${dir}" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git -C "${dir}" fetch --quiet origin "${sha}" || die "could not fetch pinned sha ${sha} from ${repo}"
  fi
  git -C "${dir}" checkout --quiet --detach "${sha}"
  [[ "$(git -C "${dir}" rev-parse HEAD)" == "${sha}" ]] || die "${dir} is not at the pinned sha ${sha}"
}

# ---------------------------------------------------------------- 2. vcpkg
if [[ ! -x "${VCPKG_ROOT}/vcpkg" ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "vcpkg bootstrap into ${VCPKG_ROOT} needs root"
  log "vcpkg: cloning into ${VCPKG_ROOT} @ pinned ${VCPKG_SHA}"
  checkout_pinned_sha "${VCPKG_REPO}" "${VCPKG_ROOT}" "${VCPKG_SHA}"
  ( cd "${VCPKG_ROOT}" && VCPKG_FORCE_SYSTEM_BINARIES=1 ./bootstrap-vcpkg.sh -disableMetrics )
  ln -sf "${VCPKG_ROOT}/vcpkg" /usr/local/bin/vcpkg
else
  log "vcpkg: present at ${VCPKG_ROOT}"
fi
log "vcpkg: $(git -C "${VCPKG_ROOT}" rev-parse --short HEAD 2>/dev/null || echo '?') (pinned ${VCPKG_SHA})"

# ---------------------------------------------------------------- 3. sample @ pinned sha
checkout_pinned_sha "${SAMPLE_REPO}" "${SAMPLE_DIR}" "${SAMPLE_SHA}"
log "sample: $(git -C "${SAMPLE_DIR}" rev-parse HEAD) (pinned ${SAMPLE_SHA})"

# ---------------------------------------------------------------- 4. SDK tarball
if [[ -z "${SDK_TARBALL}" ]]; then
  SDK_TARBALL="$(find_sdk_tarball || true)"
fi
if [[ -z "${SDK_TARBALL}" || ! -f "${SDK_TARBALL}" ]]; then
  cat >&2 <<EOF

  MISSING: Zoom Meeting SDK for Linux (arm64) tarball.

  Expected at:  ${VENDOR_DIR}/zoom-meeting-sdk-linux_arm64-<ver>.tar.xz
  (or pass --sdk-tarball <path>)

  Get it from:  Zoom App Marketplace -> your Meeting SDK / General app
                -> Features -> Embed -> Meeting SDK -> Linux -> Download (arm64)
                https://developers.zoom.us/docs/meeting-sdk/linux/get-started/download/

  The tarball is licence-gated. NEVER commit it — vendor/ is gitignored.

EOF
  die "SDK tarball not found"
fi
SDK_TARBALL="$(realpath "${SDK_TARBALL}")"
case "${SDK_TARBALL}" in
  "${VENDOR_DIR}"/*) ;;
  *) log "warn: tarball is outside ${VENDOR_DIR}; make sure it is not inside the git tree" ;;
esac
log "sdk tarball: ${SDK_TARBALL} ($(stat -c %s "${SDK_TARBALL}" 2>/dev/null || wc -c < "${SDK_TARBALL}") bytes, sha256 $(sha256sum "${SDK_TARBALL}" | cut -c1-16)…)"

mkdir -p "${SDK_LIB_DIR}"
case "${SDK_TARBALL}" in
  *.tar.xz)  tar -xJf "${SDK_TARBALL}" -C "${SDK_LIB_DIR}" --strip-components=1 ;;
  *.tar.gz|*.tgz) tar -xzf "${SDK_TARBALL}" -C "${SDK_LIB_DIR}" --strip-components=1 ;;
  *.tar)     tar -xf  "${SDK_TARBALL}" -C "${SDK_LIB_DIR}" --strip-components=1 ;;
  *) die "unsupported tarball extension: ${SDK_TARBALL}" ;;
esac
# The sample's entry.sh does exactly this before building (libmeetingsdk.so.1 soname).
if [[ -f "${SDK_LIB_DIR}/libmeetingsdk.so" && ! -f "${SDK_LIB_DIR}/libmeetingsdk.so.1" ]]; then
  cp "${SDK_LIB_DIR}/libmeetingsdk.so" "${SDK_LIB_DIR}/libmeetingsdk.so.1"
fi
[[ -f "${SDK_LIB_DIR}/libmeetingsdk.so" ]] || die "libmeetingsdk.so not found under ${SDK_LIB_DIR} after unpack (tarball layout differs from the docs?)"
[[ -d "${SDK_LIB_DIR}/h" ]] || log "warn: ${SDK_LIB_DIR}/h (headers) not found — CMake include will fail"

# ---------------------------------------------------------------- 5. receipts: arch + glibc
FILE_OUT="$(file -b "${SDK_LIB_DIR}/libmeetingsdk.so")"
log "file libmeetingsdk.so: ${FILE_OUT}"
case "${FILE_OUT}" in
  *aarch64*) log "PROVEN: libmeetingsdk.so is aarch64" ;;
  *) die "libmeetingsdk.so is NOT aarch64 — wrong tarball (x86_64?)" ;;
esac

HOST_GLIBC="$(ldd --version | head -n1 | grep -oE '[0-9]+\.[0-9]+$' || echo '?')"
# Highest GLIBC_x.y version symbol the .so requires (the real floor); falls back to the doc floor.
SO_GLIBC="$(objdump -T "${SDK_LIB_DIR}/libmeetingsdk.so" 2>/dev/null | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -t. -k2 -n -u | tail -n1 || true)"
log "glibc host: ${HOST_GLIBC} | required by .so: ${SO_GLIBC:-unknown} | doc floor (Ubuntu 22.04): ${SAMPLE_GLIBC_FLOOR}"
if command -v ldd >/dev/null; then
  log "ldd unresolved: $(ldd "${SDK_LIB_DIR}/libmeetingsdk.so" 2>&1 | grep -c 'not found' || true) missing shared libs (see receipt for the list)"
  ldd "${SDK_LIB_DIR}/libmeetingsdk.so" 2>&1 | grep 'not found' >> "${RECEIPT}" || true
fi

# ---------------------------------------------------------------- 6. ownership
# When invoked as `sudo ./prepare-pi.sh`, everything this script writes under the repo
# (SAMPLE_DIR clone, SDK_LIB_DIR unpack, RECEIPTS_DIR) lands root-owned. build.sh and
# run-join.sh are documented to run as the plain invoking user afterward and would then
# fail to write build artifacts / join receipts. Hand ownership back to $SUDO_USER.
if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
  log "ownership: chown -R ${SUDO_USER} ${SAMPLE_DIR} ${RECEIPTS_DIR}"
  chown -R "${SUDO_USER}:$(id -gn "${SUDO_USER}")" "${SAMPLE_DIR}" "${RECEIPTS_DIR}" 2>/dev/null || \
    log "warn: could not chown workspace back to ${SUDO_USER}; build.sh/run-join.sh may need sudo too"
fi

log "DONE prepare — next: ${HERE}/build.sh"
