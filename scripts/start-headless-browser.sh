#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

mkdir -p "$QFAV_BROWSER_PROFILE_DIR"

flags=(
  "--headless=new"
  "--user-data-dir=$QFAV_BROWSER_PROFILE_DIR"
  "--remote-debugging-port=$QFAV_BROWSER_PORT"
  "--mute-audio"
  "--no-first-run"
  "--no-default-browser-check"
  "--window-size=1440,1000"
  "about:blank"
)

while IFS= read -r ext_flag; do
  [[ -n "$ext_flag" ]] && flags+=("$ext_flag")
done < <(chrome_extension_flags)

echo "Starting headless test browser on http://127.0.0.1:$QFAV_BROWSER_PORT"
echo "Profile: $QFAV_BROWSER_PROFILE_DIR"

exec "$CHROME_BIN" "${flags[@]}"
