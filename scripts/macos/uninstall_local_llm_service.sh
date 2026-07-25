#!/bin/zsh
set -euo pipefail

LABEL="com.planpilot.llm"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

if [[ -f "${PLIST_PATH}" ]]; then
  TRASH_PATH="${HOME}/.Trash/${LABEL}.$(date +%Y%m%d-%H%M%S).plist"
  mv "${PLIST_PATH}" "${TRASH_PATH}"
  echo "Moved plist to ${TRASH_PATH}"
else
  echo "Service plist was not installed"
fi
