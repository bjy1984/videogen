#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${VIDEOGEN_FASTER_WHISPER_VENV:-/Volumes/7up/github/videogen/.venv-faster-whisper}"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools
"$VENV_DIR/bin/python" -m pip install faster-whisper

cat <<EOF
faster-whisper environment ready:
  $VENV_DIR/bin/python

Use:
  export VIDEOGEN_FASTER_WHISPER_PYTHON="$VENV_DIR/bin/python"
  export VIDEOGEN_FASTER_WHISPER_MODEL="medium"
EOF
