#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/qfav-browser-env.sh

echo "Serving userscript at http://127.0.0.1:$QFAV_USERSCRIPT_PORT/bilibili-quick-fav.user.js"
exec python3 -m http.server "$QFAV_USERSCRIPT_PORT" --bind 127.0.0.1
