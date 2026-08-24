#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
BACKEND_DIR="${PROJECT_ROOT}/backend"
PYTHON_BIN="${PLANPILOT_PYTHON:-$(command -v python)}"

cd "${BACKEND_DIR}"
MODEL_PATH="$("${PYTHON_BIN}" -c 'from src.config import settings; print(settings.model_name)')"

if [[ ! -d "${MODEL_PATH}" ]]; then
  echo "Local model directory does not exist: ${MODEL_PATH}" >&2
  exit 1
fi

exec "${PYTHON_BIN}" -m mlx_lm server \
  --model "${MODEL_PATH}" \
  --host 0.0.0.0 \
  --port 8080 \
  --max-tokens 2048 \
  --prompt-cache-size 4 \
  --prompt-concurrency 1 \
  --decode-concurrency 1 \
  --log-level INFO
