#!/usr/bin/env bash
set -euo pipefail

# Reproducible, dependency-free capture recipe for the checked-in lifecycle
# visualizer. Chrome renders the real HTML states; ffmpeg only assembles the
# verified PNG frames into the derived GIF. No package install or network is
# required.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
html_path="${SYNOD_CYCLE_HTML:-$repo_root/docs/synod/synod-cycle.html}"
output_path="${1:-$repo_root/docs/synod/assets/synod-cycle-loop.gif}"
chrome_path="${CHROME_BIN:-${CHROMIUM_BIN:-}}"
ffmpeg_path="${FFMPEG_BIN:-}"

find_executable() {
  local candidate
  for candidate in "$@"; do
    if [[ "$candidate" == */* && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    if [[ "$candidate" != */* ]] && command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -z "$chrome_path" ]]; then
  chrome_path="$(find_executable \
    google-chrome google-chrome-stable chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  )" || {
    printf 'Chrome/Chromium not found. Set CHROME_BIN to a headless Chrome executable.\n' >&2
    exit 1
  }
fi
if [[ -z "$ffmpeg_path" ]]; then
  ffmpeg_path="$(find_executable ffmpeg)" || {
    printf 'ffmpeg not found. Set FFMPEG_BIN to an ffmpeg executable.\n' >&2
    exit 1
  }
fi
if [[ ! -f "$html_path" ]]; then
  printf 'Synod cycle HTML does not exist: %s\n' "$html_path" >&2
  exit 1
fi

output_parent="$(dirname "$output_path")"
if [[ ! -d "$output_parent" ]]; then
  printf 'GIF output directory does not exist: %s\n' "$output_parent" >&2
  exit 1
fi

normal_steps=(
  intake ready reserve readonly-spawn bind authorize wait proposal accept verify done checkpoint handoff
)
correction_steps=(
  intake ready reserve readonly-spawn bind authorize wait proposal
  correction-policy correction-reserve correction-spawn correction-bind correction-authorize
  correction-wait correction-proposal accept verify done checkpoint handoff
)
expected_frames=$(( ${#normal_steps[@]} + ${#correction_steps[@]} ))
if [[ "$expected_frames" -ne 33 ]]; then
  printf 'Capture recipe has %s frames; expected 33.\n' "$expected_frames" >&2
  exit 1
fi

frame_dir="$(mktemp -d "${TMPDIR:-/tmp}/synod-cycle-gif.XXXXXX")"
palette_path="$frame_dir/palette.png"
temporary_output="$frame_dir/output.gif"
asset_sibling=""
cleanup() {
  if [[ -n "$asset_sibling" ]]; then rm -f "$asset_sibling"; fi
  rm -rf "$frame_dir"
}
trap cleanup EXIT

chrome_args=(
  --headless=new
  --disable-gpu
  --disable-dev-shm-usage
  --disable-extensions
  --disable-background-networking
  --disable-sync
  --force-color-profile=srgb
  --hide-scrollbars
  --no-first-run
  --no-default-browser-check
  --run-all-compositor-stages-before-draw
  --virtual-time-budget=1000
  --window-size=1120,622
  --force-device-scale-factor=1
)
if [[ "$(id -u)" == "0" ]]; then
  chrome_args+=(--no-sandbox)
fi

capture_frame() {
  local scenario="$1"
  local step="$2"
  local index="$3"
  local frame_path="$frame_dir/frame-$(printf '%03d' "$index").png"
  local dom_path="$frame_dir/frame-$(printf '%03d' "$index").dom.html"
  local url="file://$html_path?capture=gif&scenario=$scenario&step=$step"
  local profile_path="$frame_dir/chrome-profile-$index"
  mkdir "$profile_path"
  "$chrome_path" "${chrome_args[@]}" --user-data-dir="$profile_path" --screenshot="$frame_path" --dump-dom "$url" >"$dom_path" 2>"$frame_path.chrome.log" &
  local chrome_pid=$!
  local attempt
  for attempt in $(seq 1 100); do
    if [[ -s "$frame_path" && -s "$dom_path" ]]; then break; fi
    if ! kill -0 "$chrome_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  # The document intentionally has a live ResizeObserver, so headless Chrome
  # may keep its process open after writing a screenshot. The frame itself is
  # the completion signal; close this isolated browser before the next state.
  if kill -0 "$chrome_pid" 2>/dev/null; then kill "$chrome_pid" 2>/dev/null || true; fi
  wait "$chrome_pid" 2>/dev/null || true
  if [[ ! -s "$frame_path" || ! -s "$dom_path" ]]; then
    printf 'Chrome did not produce a frame for %s/%s.\n' "$scenario" "$step" >&2
    exit 1
  fi
  node --input-type=module - "$dom_path" "$scenario" "$step" <<'NODE'
import { readFileSync } from "node:fs";

const [domPath, expectedScenario, expectedStep] = process.argv.slice(2);
const dom = readFileSync(domPath, "utf8");
const element = dom.match(/<output\b[^>]*id="gif-capture-sentinel"[^>]*>[\s\S]*?<\/output>/i)?.[0];
if (!element) throw new Error("capture DOM sentinel is missing");
const attribute = name => element.match(new RegExp(`${name}="([^"]*)"`))?.[1];
if (attribute("data-gif-capture-valid") !== "true"
  || attribute("data-gif-capture-scenario") !== expectedScenario
  || attribute("data-gif-capture-step") !== expectedStep) {
  throw new Error(`capture DOM sentinel mismatch: expected ${expectedScenario}/${expectedStep}`);
}
const expectedText = `SYNOD-GIF-CAPTURE scenario=${expectedScenario} step=${expectedStep}`;
if (!element.includes(expectedText)) throw new Error(`capture DOM sentinel content mismatch: ${expectedText}`);
NODE
}

frame_index=0
for step in "${normal_steps[@]}"; do
  capture_frame normal "$step" "$frame_index"
  frame_index=$((frame_index + 1))
done
for step in "${correction_steps[@]}"; do
  capture_frame correction "$step" "$frame_index"
  frame_index=$((frame_index + 1))
done

# Validate every source PNG before handing it to ffmpeg. The capture sentinel
# protects the requested DOM state; this content check protects against a
# browser/renderer failure that repeats one blank or stale image for many
# different states.
node --input-type=module - "$frame_dir" "$expected_frames" "${#normal_steps[@]}" "${#correction_steps[@]}" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [frameDir, expectedFramesText, normalText, correctionText] = process.argv.slice(2);
const expectedFrames = Number(expectedFramesText);
const normalFrames = Number(normalText);
const correctionFrames = Number(correctionText);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngContentHash(path) {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`not a PNG: ${path}`);
  if (bytes.readUInt32BE(16) !== 1120 || bytes.readUInt32BE(20) !== 622) {
    throw new Error(`PNG must be 1120x622: ${path}`);
  }
  const idat = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`truncated PNG chunk in ${path}`);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset = end;
    if (type === "IEND") break;
  }
  if (idat.length === 0) throw new Error(`PNG has no image data: ${path}`);
  return createHash("sha256").update(Buffer.concat(idat)).digest("hex");
}

const hashes = [];
for (let index = 0; index < expectedFrames; index += 1) {
  const path = join(frameDir, `frame-${String(index).padStart(3, "0")}.png`);
  hashes.push(pngContentHash(path));
}
const normalHashes = new Set(hashes.slice(0, normalFrames));
const correctionHashes = new Set(hashes.slice(normalFrames, normalFrames + correctionFrames));
const requiredNormalDiversity = Math.min(4, normalFrames);
const requiredCorrectionDiversity = Math.min(4, correctionFrames);
if (normalHashes.size < requiredNormalDiversity) {
  throw new Error(`normal PNG content is not representative: ${normalHashes.size} unique hashes`);
}
if (correctionHashes.size < requiredCorrectionDiversity) {
  throw new Error(`correction PNG content is not representative: ${correctionHashes.size} unique hashes`);
}
const allHashes = new Set([...normalHashes, ...correctionHashes]);
if (allHashes.size === Math.max(normalHashes.size, correctionHashes.size)) {
  throw new Error("normal and correction PNG content are identical");
}
console.log(`Validated ${expectedFrames} PNG frames, ${normalHashes.size} normal and ${correctionHashes.size} correction content hashes.`);
NODE

"$ffmpeg_path" -hide_banner -loglevel error -y \
  -framerate 3 -i "$frame_dir/frame-%03d.png" \
  -vf "scale=1120:622:flags=lanczos,palettegen=stats_mode=diff" \
  "$palette_path"
"$ffmpeg_path" -hide_banner -loglevel error -y \
  -framerate 3 -i "$frame_dir/frame-%03d.png" \
  -i "$palette_path" \
  -lavfi "scale=1120:622:flags=lanczos [scaled]; [scaled][1:v] paletteuse=dither=sierra2_4a" \
  -loop 0 -f gif "$temporary_output"

# Validate the actual bytes before replacing the checked-in asset. This keeps
# a failed capture from silently overwriting a known-good GIF.
validate_gif() {
  local gif_path="$1"
  node --input-type=module - "$gif_path" "$expected_frames" "${#normal_steps[@]}" "${#correction_steps[@]}" <<'NODE'
import { readFileSync } from "node:fs";

const [gifPath, expectedFramesText, normalText, correctionText] = process.argv.slice(2);
const expectedFrames = Number(expectedFramesText);
const normalFrames = Number(normalText);
const correctionFrames = Number(correctionText);
const bytes = readFileSync(gifPath);
if (bytes.subarray(0, 6).toString("ascii") !== "GIF89a") throw new Error("capture is not GIF89a");
if (bytes.readUInt16LE(6) !== 1120 || bytes.readUInt16LE(8) !== 622) throw new Error("capture must be 1120x622");
let frames = 0;
let durationCentiseconds = 0;
for (let index = 0; index + 7 < bytes.length; index += 1) {
  if (bytes[index] !== 0x21 || bytes[index + 1] !== 0xf9 || bytes[index + 2] !== 0x04) continue;
  frames += 1;
  const delay = bytes.readUInt16LE(index + 4);
  if (delay < 30 || delay > 36) throw new Error(`unexpected frame delay: ${delay}`);
  durationCentiseconds += delay;
}
if (frames !== expectedFrames) throw new Error(`expected ${expectedFrames} frames, found ${frames}`);
if (normalFrames < 1 || correctionFrames < 1) throw new Error("normal and correction scenarios are both required");
if (bytes.at(-1) !== 0x3b) throw new Error("GIF trailer is missing");
if (bytes.byteLength < 100_000) throw new Error("capture is unexpectedly small");
if (durationCentiseconds < 990 || durationCentiseconds > 1200) throw new Error(`unexpected duration: ${durationCentiseconds}cs`);
console.log(`Validated ${frames} frames (${normalFrames} normal + ${correctionFrames} correction), 1120x622, approximately 11s.`);
NODE
}

validate_gif "$temporary_output"

# Keep all work-in-progress outside the checkout. Once the external artifact
# is validated, copy it to a sibling in the destination directory, validate
# that exact bytes-to-be-renamed file, and atomically replace the asset.
asset_sibling="$(mktemp "${output_path}.tmp.XXXXXX")"
cp "$temporary_output" "$asset_sibling"
validate_gif "$asset_sibling"
mv -f "$asset_sibling" "$output_path"
asset_sibling=""

trap - EXIT
rm -rf "$frame_dir"
printf 'Wrote %s\n' "$output_path"
