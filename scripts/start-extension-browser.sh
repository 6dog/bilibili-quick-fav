#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

extension_dir="${QFAV_EXTENSION_DIR:-$PWD/dist/extension}"
if [[ ! -f "$extension_dir/manifest.json" ]]; then
  echo "Extension build is missing: $extension_dir/manifest.json" >&2
  echo "Run npm run build first." >&2
  exit 1
fi

if curl -fsS --max-time 2 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null 2>&1; then
  echo "A browser is already listening on port $QFAV_BROWSER_PORT; reuse or stop it first." >&2
  exit 2
fi

mkdir -p "$QFAV_BROWSER_PROFILE_DIR"
flags=(
  "--headless=new"
  "--enable-unsafe-extension-debugging"
  "--user-data-dir=$QFAV_BROWSER_PROFILE_DIR"
  "--remote-debugging-port=$QFAV_BROWSER_PORT"
  "--mute-audio"
  "--no-first-run"
  "--no-default-browser-check"
  "--window-size=1440,1000"
  "about:blank"
)

echo "Starting isolated extension test browser on port $QFAV_BROWSER_PORT"
echo "Extension: $extension_dir"
mkdir -p .qfav-browser
"$CHROME_BIN" "${flags[@]}" >.qfav-browser/extension-chrome.log 2>&1 &
chrome_pid="$!"
cleanup() {
  kill "$chrome_pid" >/dev/null 2>&1 || true
  wait "$chrome_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in {1..40}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS --max-time 2 "http://127.0.0.1:$QFAV_BROWSER_PORT/json/version" >/dev/null
QFAV_EXTENSION_DIR="$extension_dir" node scripts/load-extension-browser.mjs
echo "Isolated extension browser is ready."
wait "$chrome_pid"
