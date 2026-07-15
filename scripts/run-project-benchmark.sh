#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$(realpath "${1:-$ROOT/app/dist}")"
BASE_PATH="${BASE_PATH:-/fhir-ig-editor/}"
SERVER_PORT="${SERVER_PORT:-4174}"
CDP_PORT="${CDP_PORT:-9222}"
PROJECT="${BENCH_PROJECT:-uscore}"
WORK_ROOT="${BENCH_WORK_ROOT:-${TMPDIR:-/tmp}}"

[[ -d "$DIST" && -f "$DIST/index.html" ]] || {
  echo "run-project-benchmark: missing built site at $DIST" >&2
  exit 2
}
[[ "$BASE_PATH" == /*/ && "$BASE_PATH" != *..* ]] || {
  echo "run-project-benchmark: BASE_PATH must be an absolute trailing-slash path" >&2
  exit 2
}
[[ "$SERVER_PORT" =~ ^[0-9]+$ && "$CDP_PORT" =~ ^[0-9]+$ ]] || {
  echo "run-project-benchmark: SERVER_PORT and CDP_PORT must be integers" >&2
  exit 2
}

CHROME="${CHROME_BIN:-}"
if [[ -z "$CHROME" ]]; then
  for candidate in chromium chromium-browser google-chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then CHROME="$(command -v "$candidate")"; break; fi
  done
fi
[[ -x "$CHROME" ]] || { echo "run-project-benchmark: Chromium not found" >&2; exit 2; }
BUN="${BUN_BIN:-$(command -v bun || true)}"
[[ -x "$BUN" ]] || { echo "run-project-benchmark: Bun not found" >&2; exit 2; }

mkdir -p "$WORK_ROOT"
WORK="$(mktemp -d "$WORK_ROOT/fhir-ig-project-benchmark.XXXXXX")"
SERVE_ROOT="$WORK/serve"
SITE_ROOT="$SERVE_ROOT${BASE_PATH%/}"
PROFILE="$WORK/chrome-profile"
SERVER_LOG="$WORK/server.log"
CHROME_LOG="$WORK/chrome.log"
MEMORY_FILE="$WORK/process-memory.json"
mkdir -p "$SITE_ROOT" "$PROFILE"
cp -a "$DIST/." "$SITE_ROOT/"

SERVER_PID=""
CHROME_PID=""
SAMPLER_PID=""
SCOPE_UNIT=""

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  [[ -n "$SAMPLER_PID" ]] && kill "$SAMPLER_PID" 2>/dev/null || true
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  if [[ -n "$SCOPE_UNIT" ]]; then
    systemctl --user stop "$SCOPE_UNIT.scope" >/dev/null 2>&1 || true
  fi
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "$CHROME_PID" ]] && wait "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  if (( status != 0 )); then
    echo "[project-benchmark:$PROJECT] static server log:" >&2
    [[ -f "$SERVER_LOG" ]] && tail -200 "$SERVER_LOG" >&2 || true
    echo "[project-benchmark:$PROJECT] Chrome log:" >&2
    [[ -f "$CHROME_LOG" ]] && tail -200 "$CHROME_LOG" >&2 || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM

readarray -t IDENTITY < <(node --input-type=module - "$DIST" "$ROOT" <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const [, , dist, root] = process.argv;
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const files = [];
async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(path, name);
    else if (entry.isFile()) files.push({ name, path });
  }
}
await walk(dist);
const artifact = createHash('sha256');
artifact.update(Buffer.from('fhir-ig-editor-benchmark-artifact-v1\0'));
let byteLength = 0;
for (const file of files) {
  const name = Buffer.from(file.name);
  const info = await stat(file.path);
  artifact.update(u64(name.byteLength));
  artifact.update(name);
  artifact.update(u64(info.size));
  artifact.update(await readFile(file.path));
  byteLength += info.size;
}
const recipeNames = [
  'scripts/benchmark-cdp-lifecycle.mjs',
  'scripts/benchmark-matrix.mjs',
  'scripts/benchmark-project.mjs',
  'scripts/run-project-benchmark.sh',
];
const recipe = createHash('sha256');
recipe.update(Buffer.from('fhir-ig-editor-benchmark-runner-v1\0'));
for (const name of recipeNames) {
  const encoded = Buffer.from(name);
  const bytes = await readFile(join(root, name));
  recipe.update(u64(encoded.byteLength));
  recipe.update(encoded);
  recipe.update(u64(bytes.byteLength));
  recipe.update(bytes);
}
console.log(artifact.digest('hex'));
console.log(files.length);
console.log(byteLength);
console.log(recipe.digest('hex'));
NODE
)
ARTIFACT_SHA="${IDENTITY[0]}"
ARTIFACT_FILES="${IDENTITY[1]}"
ARTIFACT_BYTES="${IDENTITY[2]}"
RECIPE_SHA="${IDENTITY[3]}"
if [[ -n "${BENCH_EXPECTED_RUNNER_RECIPE_SHA256:-}" \
      && "$RECIPE_SHA" != "$BENCH_EXPECTED_RUNNER_RECIPE_SHA256" ]]; then
  echo "run-project-benchmark: runner recipe drift: $RECIPE_SHA != $BENCH_EXPECTED_RUNNER_RECIPE_SHA256" >&2
  exit 2
fi

export BENCH_ARTIFACT_SHA256="$ARTIFACT_SHA"
export BENCH_ARTIFACT_FILE_COUNT="$ARTIFACT_FILES"
export BENCH_ARTIFACT_BYTE_LENGTH="$ARTIFACT_BYTES"
export BENCH_RUNNER_RECIPE_SHA256="$RECIPE_SHA"
export BENCH_RUNNER_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  export BENCH_RUNNER_DIRTY=1
else
  export BENCH_RUNNER_DIRTY=0
fi
export BENCH_RUNTIME_VERSION="$("$BUN" --version)"
export BENCH_CHROME_BINARY_SHA256="$(sha256sum "$CHROME" | awk '{print $1}')"
export BENCH_HOST_OS="$(uname -s)"
export BENCH_HOST_KERNEL="$(uname -r)"
export BENCH_HOST_ARCH="$(uname -m)"
export BENCH_HOST_CPU_MODEL="$(awk -F: '/model name/{sub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
export BENCH_HOST_LOGICAL_CPUS="$(nproc)"
export BENCH_HOST_MEMORY_BYTES="$(awk '/MemTotal/{print $2 * 1024; exit}' /proc/meminfo | cut -d. -f1)"
export BENCH_PROCESS_MEMORY_FILE="$MEMORY_FILE"

echo "[project-benchmark:$PROJECT] Chromium $("$CHROME" --version | sed -E 's/^[^0-9]*//') at http://127.0.0.1:$SERVER_PORT$BASE_PATH" >&2
echo "[project-benchmark:$PROJECT] artifact $ARTIFACT_SHA ($ARTIFACT_FILES files, $ARTIFACT_BYTES bytes)" >&2
echo "[project-benchmark:$PROJECT] runner recipe $RECIPE_SHA" >&2

python3 -m http.server "$SERVER_PORT" --bind 127.0.0.1 --directory "$SERVE_ROOT" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in {1..100}; do
  if curl -fsS "http://127.0.0.1:$SERVER_PORT$BASE_PATH" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
curl -fsS "http://127.0.0.1:$SERVER_PORT$BASE_PATH" >/dev/null

SESSION="$$-$RANDOM-$RANDOM"
CHROME_ARGS=(
  --headless=new
  --disable-dev-shm-usage
  --no-first-run
  --no-default-browser-check
  --disable-background-timer-throttling
  --disable-renderer-backgrounding
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$CDP_PORT"
  --user-data-dir="$PROFILE"
  --noerrdialogs
  --ozone-platform=headless
  --ozone-override-screen-size=800,600
  --use-angle=swiftshader-webgl
  "http://127.0.0.1:$SERVER_PORT${BASE_PATH}__benchmark_probe__?session=$SESSION"
)

QUOTA="${BENCH_CHROME_CPU_QUOTA_PERCENT:-}"
if [[ -n "$QUOTA" ]]; then
  [[ "$QUOTA" =~ ^[0-9]+$ && "$QUOTA" -ge 1 && "$QUOTA" -le 100 ]] || {
    echo "run-project-benchmark: BENCH_CHROME_CPU_QUOTA_PERCENT must be 1..100" >&2
    exit 2
  }
  SCOPE_UNIT="fhir-ig-benchmark-${USER//[^a-zA-Z0-9]/-}-$$-$RANDOM"
  systemd-run --user --scope --quiet --unit="$SCOPE_UNIT" \
    --property="CPUQuota=${QUOTA}%" -- "$CHROME" "${CHROME_ARGS[@]}" \
    >"$CHROME_LOG" 2>&1 &
  CHROME_PID=$!
  APPLIED=""
  for _ in {1..100}; do
    APPLIED="$(systemctl --user show "$SCOPE_UNIT.scope" \
      --property=CPUQuotaPerSecUSec --value 2>/dev/null || true)"
    [[ -n "$APPLIED" && "$APPLIED" != "infinity" ]] && break
    sleep 0.05
  done
  [[ -n "$APPLIED" && "$APPLIED" != "infinity" ]] || {
    echo "run-project-benchmark: requested CPU quota was not applied" >&2
    exit 2
  }
  export BENCH_CHROME_CPU_QUOTA_APPLIED="$APPLIED"
  export BENCH_CHROME_CPU_QUOTA_UNIT="$SCOPE_UNIT.scope"
  echo "[project-benchmark:$PROJECT] whole-Chrome CPU quota ${QUOTA}% ($APPLIED) via $SCOPE_UNIT.scope" >&2
else
  "$CHROME" "${CHROME_ARGS[@]}" >"$CHROME_LOG" 2>&1 &
  CHROME_PID=$!
fi

sample_process_tree() {
  local root_pid="$1" peak_kib=0 peak_count=0
  while kill -0 "$root_pid" 2>/dev/null; do
    local -a queue=("$root_pid") pids=()
    local index=0 pid child
    while (( index < ${#queue[@]} )); do
      pid="${queue[$index]}"; index=$((index + 1))
      kill -0 "$pid" 2>/dev/null || continue
      pids+=("$pid")
      while read -r child; do [[ -n "$child" ]] && queue+=("$child"); done < <(pgrep -P "$pid" || true)
    done
    if (( ${#pids[@]} > 0 )); then
      local csv rss_kib count
      csv="$(IFS=,; echo "${pids[*]}")"
      rss_kib="$(ps -o rss= -p "$csv" 2>/dev/null | awk '{sum += $1} END {print sum + 0}')"
      count="${#pids[@]}"
      (( rss_kib > peak_kib )) && peak_kib="$rss_kib"
      (( count > peak_count )) && peak_count="$count"
      printf '{"available":true,"observedPeakProcessTreeRssBytes":%s,"observedPeakProcessCount":%s}\n' \
        "$((peak_kib * 1024))" "$peak_count" >"$MEMORY_FILE.tmp"
      mv "$MEMORY_FILE.tmp" "$MEMORY_FILE"
    fi
    sleep 0.1
  done
}
sample_process_tree "$CHROME_PID" &
SAMPLER_PID=$!

cd "$ROOT"
CDP_PORT="$CDP_PORT" "$BUN" scripts/benchmark-project.mjs \
  "http://127.0.0.1:$SERVER_PORT$BASE_PATH"
