#!/usr/bin/env bash
# Serve the exact Vite artifact, launch a fresh headless Chrome profile, and run
# the CDP E2E gate (which includes the preview runtime-closure check).
#
#   BASE_PATH=/ bash scripts/run-browser-gates.sh app/dist
#   BASE_PATH=/fhir-ig-editor/ CHROME_BIN=/path/to/chrome \
#     CHROME_NO_SANDBOX=1 \
#     bash scripts/run-browser-gates.sh app/dist
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DIST="$(cd "${1:-$REPO/app/dist}" && pwd)"
SERVER_PORT="${SERVER_PORT:-4173}"
CDP_PORT="${CDP_PORT:-9222}"
BASE_PATH="${BASE_PATH:-/}"
BASE_PATH="/${BASE_PATH#/}"
if [ "$BASE_PATH" != / ]; then BASE_PATH="${BASE_PATH%/}/"; fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fhir-ig-browser.XXXXXX")"
SERVER_LOG="$WORK/server.log"
CHROME_LOG="$WORK/chrome.log"

server_pid=''
chrome_pid=''
cleanup() {
  [ -z "$chrome_pid" ] || kill "$chrome_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  wait "$chrome_pid" "$server_pid" 2>/dev/null || true
  # Chromium can release profile files a moment after its parent exits. A
  # cleanup race must not turn an otherwise successful product gate red.
  rm -rf "$WORK" 2>/dev/null || true
}
on_error() {
  echo "[browser-gates] static server log:" >&2
  tail -100 "$SERVER_LOG" >&2 2>/dev/null || true
  echo "[browser-gates] Chrome log:" >&2
  tail -100 "$CHROME_LOG" >&2 2>/dev/null || true
}
trap cleanup EXIT
trap on_error ERR

# Serve an immutable snapshot. This matters locally when another build is
# produced in the shared worktree while a long browser gate is running, and in
# CI it guarantees every request belongs to the one artifact being certified.
mkdir -p "$WORK/artifact"
cp -a "$DIST/." "$WORK/artifact/"
DIST="$WORK/artifact"

# Optional rolling-deployment regression: install the prior unversioned worker
# before loading the current app. Fixtures are copied only into this disposable
# artifact and are never part of the Pages upload.
if [ "${PREINSTALL_LEGACY_PREVIEW_SW:-0}" = 1 ]; then
  cp "$HERE/fixtures/legacy-preview-sw.js" "$DIST/__legacy-preview-sw.js"
  cp "$HERE/fixtures/legacy-preview-bootstrap.html" "$DIST/__legacy-preview-bootstrap.html"
fi

if [ "$BASE_PATH" = / ]; then
  SERVER_ROOT="$DIST"
else
  SERVER_ROOT="$WORK/www"
  relative="${BASE_PATH#/}"
  relative="${relative%/}"
  mkdir -p "$SERVER_ROOT/$(dirname "$relative")"
  ln -s "$DIST" "$SERVER_ROOT/$relative"
fi

if [ -n "${CHROME_BIN:-}" ]; then
  chrome="$CHROME_BIN"
else
  chrome=''
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome="$(command -v "$candidate")"
      break
    fi
  done
fi
[ -n "$chrome" ] && [ -x "$chrome" ] || {
  echo "FATAL: Chrome not found; set CHROME_BIN" >&2
  exit 2
}

python3 -m http.server "$SERVER_PORT" --bind 127.0.0.1 --directory "$SERVER_ROOT" >"$SERVER_LOG" 2>&1 &
server_pid=$!

url="http://127.0.0.1:${SERVER_PORT}${BASE_PATH}"
chrome_args=(
  --headless=new
  --disable-dev-shm-usage
  --no-first-run
  --no-default-browser-check
  --remote-debugging-address=127.0.0.1
  "--remote-debugging-port=$CDP_PORT"
  "--user-data-dir=$WORK/chrome-profile"
  about:blank
)
# Root cannot use Chrome's normal namespace sandbox. Some CI-provisioned Chrome
# archives also ship an unusable SUID helper; those callers opt out explicitly
# rather than weakening ordinary local non-root runs.
if [ "$(id -u)" -eq 0 ] || [ "${CHROME_NO_SANDBOX:-0}" = 1 ]; then
  chrome_args+=(--no-sandbox)
fi
"$chrome" "${chrome_args[@]}" >"$CHROME_LOG" 2>&1 &
chrome_pid=$!

for _ in $(seq 1 120); do
  if curl -fsS "$url" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS "$url" >/dev/null
curl -fsS "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null

if command -v bun >/dev/null 2>&1; then runtime=bun; else runtime=node; fi
echo "[browser-gates] $($chrome --version) at $url"
CDP_PORT="$CDP_PORT" "$runtime" "$HERE/verify-e2e.mjs" "$url"
