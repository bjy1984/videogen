#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv-depth-video"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/scripts/requirements-depth-video.txt"

echo "Depth video venv ready: $VENV_DIR"
echo "Default ONNX model path: $ROOT_DIR/models/depth_anything_vits14_fabiosim_v1_opencv_static_upsample.onnx"
echo "Override with VIDEOGEN_DEPTH_ANYTHING_ONNX=/path/to/depth_anything_opencv.onnx"
