#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

mkdir -p "$QFAV_BROWSER_PROFILE_DIR"

flags=(
  "--user-data-dir=$QFAV_BROWSER_PROFILE_DIR"
  "--remote-debugging-port=$QFAV_BROWSER_PORT"
  "--no-first-run"
  "--no-default-browser-check"
  "--window-size=1440,1000"
)

while IFS= read -r ext_flag; do
  [[ -n "$ext_flag" ]] && flags+=("$ext_flag")
done < <(chrome_extension_flags)

urls=("https://t.bilibili.com/")
if [[ "${QFAV_OPEN_INSTALL_PAGE:-0}" == "1" ]]; then
  urls+=("http://127.0.0.1:$QFAV_USERSCRIPT_PORT/bilibili-quick-fav.user.js")
fi

echo "Opening dedicated test browser profile:"
echo "  $QFAV_BROWSER_PROFILE_DIR"
echo
echo "If this is the first setup, log in to Bilibili here and install/enable the userscript."

exec "$CHROME_BIN" "${flags[@]}" "${urls[@]}"
