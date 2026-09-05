#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

release_zip="${QFAV_RELEASE_ZIP:-$PWD/dist/release/bilibili-quick-fav-2.0.2.zip}"
if [[ ! -f "$release_zip" ]]; then
  echo "Release ZIP is missing: $release_zip" >&2
  exit 1
fi
if curl -fsS --max-time 2 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null 2>&1; then
  echo "A browser is already listening on port $QFAV_BROWSER_PORT" >&2
  exit 2
fi

test_dir="$(mktemp -d "${TMPDIR:-/tmp}/qfav-release-2.0.2.XXXXXX")"
chrome_log="$test_dir/chrome.log"
chrome_pid=""
cleanup() {
  if [[ -n "$chrome_pid" ]]; then
    kill "$chrome_pid" >/dev/null 2>&1 || true
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

QFAV_EXTENSION_DIR="$test_dir/extension" node scripts/load-extension-browser.mjs
node scripts/check-extension-browser.mjs --toggle-favorite
