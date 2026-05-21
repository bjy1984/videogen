#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${ROOT}/.venv-face-mosaic"

if [[ ! -x "$(command -v python3)" ]]; then
  echo "python3 is required but was not found in PATH." >&2
  exit 1
fi

echo "Creating privacy preprocessing venv at ${VENV}"
python3 -m venv "${VENV}"

PYTHON="${VENV}/bin/python"
if [[ ! -x "${PYTHON}" ]]; then
  PYTHON="${VENV}/Scripts/python.exe"
fi

"${PYTHON}" -m pip install --upgrade pip
"${PYTHON}" -m pip install -r "${ROOT}/scripts/requirements-face-mosaic.txt"
"${PYTHON}" -m pip install -r "${ROOT}/scripts/requirements-brand-mask.txt"

echo "Done. Python interpreter: ${PYTHON}"
echo "Bundled ffmpeg (imageio-ffmpeg) is used when system ffmpeg is not installed."
