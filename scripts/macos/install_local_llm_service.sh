#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
PYTHON_BIN="${PLANPILOT_PYTHON:-$(command -v python)}"
LABEL="com.planpilot.llm"
DOMAIN="gui/$(id -u)"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/PlanPilot"
TMP_PLIST="$(mktemp -t planpilot-llm.XXXXXX)"

trap 'rm -f "${TMP_PLIST}"' EXIT

if ! "${PYTHON_BIN}" -c "import mlx_lm" >/dev/null 2>&1; then
  echo "mlx_lm is not installed for ${PYTHON_BIN}" >&2
  exit 1
fi

MODEL_PATH="$(cd "${PROJECT_ROOT}/backend" && \
  "${PYTHON_BIN}" -c 'from src.config import settings; print(settings.model_name)')"
if [[ ! -d "${MODEL_PATH}" ]]; then
  echo "Local model directory does not exist: ${MODEL_PATH}" >&2
  exit 1
fi
mkdir -p "${PLIST_DIR}" "${LOG_DIR}"

plutil -create xml1 "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :Label string ${LABEL}" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${PYTHON_BIN}" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string -m" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:2 string mlx_lm" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:3 string server" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:4 string --model" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:5 string ${MODEL_PATH}" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:6 string --host" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:7 string 0.0.0.0" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:8 string --port" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:9 string 8080" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:10 string --max-tokens" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:11 string 2048" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:12 string --prompt-cache-size" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:13 string 4" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:14 string --prompt-concurrency" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:15 string 1" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:16 string --decode-concurrency" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:17 string 1" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:18 string --log-level" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:19 string INFO" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 10" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string ${LOG_DIR}/llm.stdout.log" "${TMP_PLIST}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string ${LOG_DIR}/llm.stderr.log" "${TMP_PLIST}"
plutil -lint "${TMP_PLIST}" >/dev/null

launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
install -m 600 "${TMP_PLIST}" "${PLIST_PATH}"
for attempt in 1 2 3; do
  if launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"; then
    break
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    echo "Failed to bootstrap ${LABEL} after ${attempt} attempts" >&2
    exit 1
  fi
  sleep 1
done

echo "Installed ${LABEL}"
echo "Model: ${MODEL_PATH}"
echo "Health: http://localhost:8080/v1/models"
