#!/usr/bin/env bash
set -euo pipefail

export QFAV_BROWSER_PROFILE_DIR="${QFAV_BROWSER_PROFILE_DIR:-$HOME/.codex-browsers/bilibili-quick-fav}"
export QFAV_BROWSER_PORT="${QFAV_BROWSER_PORT:-9333}"
export QFAV_USERSCRIPT_PORT="${QFAV_USERSCRIPT_PORT:-8765}"

if [[ -z "${CHROME_BIN:-}" ]]; then
  export CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi

detect_tampermonkey_extension() {
  local ext_id="${QFAV_TAMPERMONKEY_ID:-dhdgffkkebhmkfjojejmpbldmpobfkfo}"
  local ext_root="${QFAV_CHROME_SOURCE_PROFILE:-$HOME/Library/Application Support/Google/Chrome/Default}/Extensions/$ext_id"

  if [[ ! -d "$ext_root" ]]; then
    return 1
  fi

  find "$ext_root" -mindepth 1 -maxdepth 1 -type d | sort -Vr | head -n 1
}

chrome_extension_flags() {
  if [[ "${QFAV_LOAD_TAMPERMONKEY:-1}" == "0" ]]; then
    return 0
  fi

  local tampermonkey_path
  if tampermonkey_path="$(detect_tampermonkey_extension)"; then
    printf '%s\n' "--disable-extensions-except=$tampermonkey_path"
    printf '%s\n' "--load-extension=$tampermonkey_path"
  fi
}
