#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

release_version="$(node -p "require('./package.json').version")"
release_zip="${QFAV_RELEASE_ZIP:-$PWD/dist/release/bilibili-quick-fav-${release_version}.zip}"
if [[ ! -f "$release_zip" ]]; then
  echo "Release ZIP is missing: $release_zip" >&2
  exit 1
fi
if curl -fsS --max-time 2 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null 2>&1; then
  echo "A browser is already listening on port $QFAV_BROWSER_PORT" >&2
  exit 2
fi

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/qfav-release-${release_version}.XXXXXX")"
chrome_log="$test_dir/chrome.log"
chrome_pid=""
cleanup() {
  if [[ -n "$chrome_pid" ]]; then
    kill "$chrome_pid" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      kill -0 "$chrome_pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -KILL "$chrome_pid" >/dev/null 2>&1 || true
    wait "$chrome_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT INT TERM

unzip -q "$release_zip" -d "$test_dir/extension"
"$CHROME_BIN" \
  --headless=new \
  --enable-unsafe-extension-debugging \
  --user-data-dir="$QFAV_BROWSER_PROFILE_DIR" \
  --remote-debugging-port="$QFAV_BROWSER_PORT" \
  --mute-audio \
  --no-first-run \
  --no-default-browser-check \
  --window-size=1440,1000 \
  about:blank >"$chrome_log" 2>&1 &
chrome_pid="$!"

for _ in {1..40}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS --max-time 2 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null

load_result="$(QFAV_EXTENSION_DIR="$test_dir/extension" node scripts/load-extension-browser.mjs)"
echo "$load_result"
extension_id="$(node -p 'JSON.parse(process.argv[1]).id' "$load_result")"
if [[ "${QFAV_ALLOW_FAVORITE_WRITE:-0}" == "1" ]]; then
  export QFAV_TEST_FOLDER_ID="${QFAV_TEST_FOLDER_ID:-auto}"
fi
if [[ "${QFAV_ALLOW_FAVORITE_WRITE:-0}" == "1" && "${QFAV_FAVORITE_ONLY:-0}" == "1" ]]; then
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs --toggle-favorite --favorite-only
elif [[ "${QFAV_ALLOW_FAVORITE_WRITE:-0}" == "1" ]]; then
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs --toggle-favorite
elif [[ "${QFAV_CAPTURE_STORE_SCREENSHOT:-0}" == "1" ]]; then
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs --capture-store-screenshot --video-only
elif [[ "${QFAV_CAPTURE_STORE_ASSETS:-0}" == "1" ]]; then
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs --capture-store-assets
elif [[ "${QFAV_SPEED_DIAGNOSTICS:-0}" == "1" ]]; then
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs --speed-diagnostics --video-only
else
  QFAV_EXTENSION_ID="$extension_id" node scripts/check-extension-browser.mjs
fi
