#!/usr/bin/env python3
"""Generate a browser-playable Depth Anything video with OpenCV DNN."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np


IMAGENET_MEAN = (123.675, 116.28, 103.53)
IMAGENET_STD = (58.395, 57.12, 57.375)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Depth Anything video from an input clip.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="depth-anything-dnn")
    parser.add_argument(
        "--model-path",
        default=os.environ.get("VIDEOGEN_DEPTH_ANYTHING_ONNX", ""),
        help="Depth Anything ONNX path for OpenCV DNN. Defaults to VIDEOGEN_DEPTH_ANYTHING_ONNX.",
    )
    parser.add_argument("--input-size", type=int, default=518, help="Square DNN input size.")
    parser.add_argument("--letterbox", action=argparse.BooleanOptionalAction, default=True, help="Preserve source aspect ratio with padding before DNN inference.")
    parser.add_argument("--edge-filter-strength", type=float, default=0.35, help="0 disables edge-aware smoothing, 1 applies full filtered depth.")
    parser.add_argument("--edge-filter-diameter", type=int, default=7, help="Joint bilateral filter diameter.")
    parser.add_argument("--edge-filter-sigma-color", type=float, default=42.0)
    parser.add_argument("--edge-filter-sigma-space", type=float, default=9.0)
    parser.add_argument("--resolution", choices=["source", "720p", "1080p"], default="source")
    parser.add_argument("--fps", type=float, default=0.0, help="0 keeps source FPS.")
    parser.add_argument("--color-mode", choices=["grayscale", "magma", "inferno"], default="grayscale")
    parser.add_argument("--invert", action="store_true")
    parser.add_argument("--codec", default="mp4v")
    parser.add_argument("--crf", default="18")
    parser.add_argument("--keep-temp", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input video does not exist: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    summary = process_video(input_path, output_path, args)
    print(json.dumps(summary, ensure_ascii=True))
    return 0


def process_video(input_path: Path, output_path: Path, args: argparse.Namespace) -> dict:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {input_path}")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    fps = args.fps if args.fps and args.fps > 0 else source_fps
    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    width, height = target_size(source_width, source_height, args.resolution)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        raise SystemExit("Input video has invalid dimensions.")
    net = build_depth_anything_net(args.model_path)

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_depth_"))
    temp_video = temp_dir / "depth_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    processed_frames = 0
    started_at = time.time()
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if (frame.shape[1], frame.shape[0]) != (width, height):
                frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
            depth_frame = depth_anything_frame(
                frame,
                net,
                args.input_size,
                args.color_mode,
                args.invert,
                args.letterbox,
                args.edge_filter_strength,
                args.edge_filter_diameter,
                args.edge_filter_sigma_color,
                args.edge_filter_sigma_space,
            )
            writer.write(depth_frame)
            processed_frames += 1
    finally:
        capture.release()
        writer.release()

    merge_audio(input_path, temp_video, output_path, args.crf)
    cleanup_temp(temp_dir, args.keep_temp)
    return {
        "algorithm": "opencv-dnn-depth-anything",
        "model": args.model,
        "modelPath": str(Path(args.model_path).expanduser().resolve()),
        "frameCount": processed_frames,
        "sourceFrameCount": frame_count,
        "width": width,
        "height": height,
        "fps": fps,
        "durationSec": round(processed_frames / fps, 3) if fps else None,
        "elapsedSec": round(time.time() - started_at, 3),
        "inputSize": args.input_size,
        "letterbox": bool(args.letterbox),
        "edgeFilter": {
            "strength": float(args.edge_filter_strength),
            "diameter": int(args.edge_filter_diameter),
            "sigmaColor": float(args.edge_filter_sigma_color),
            "sigmaSpace": float(args.edge_filter_sigma_space),
            "mode": edge_filter_mode(),
        },
        "output": str(output_path),
    }


def target_size(width: int, height: int, resolution: str) -> tuple[int, int]:
    if resolution == "source":
        return width, height
    max_height = 720 if resolution == "720p" else 1080
    if height <= max_height:
        return width, height
    scale = max_height / float(height)
    target_width = max(2, int(round(width * scale / 2.0)) * 2)
    return target_width, max_height


def build_depth_anything_net(model_path: str) -> cv2.dnn_Net:
    if not model_path:
        raise SystemExit(
            "Depth Anything ONNX model path is required. Set VIDEOGEN_DEPTH_ANYTHING_ONNX "
            "or pass --model-path /path/to/depth_anything.onnx."
        )
    resolved = Path(model_path).expanduser().resolve()
    if not resolved.exists():
        raise SystemExit(f"Depth Anything ONNX model does not exist: {resolved}")
    net = cv2.dnn.readNetFromONNX(str(resolved))
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
    net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    return net


def depth_anything_frame(
    frame: np.ndarray,
    net: cv2.dnn_Net,
    input_size: int,
    color_mode: str,
    invert: bool,
    letterbox: bool,
    edge_filter_strength: float,
    edge_filter_diameter: int,
    edge_filter_sigma_color: float,
    edge_filter_sigma_space: float,
) -> np.ndarray:
    height, width = frame.shape[:2]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    if letterbox:
        model_input, meta = letterbox_image(rgb, input_size)
    else:
        model_input = cv2.resize(rgb, (input_size, input_size), interpolation=cv2.INTER_CUBIC)
        meta = None
    blob = cv2.dnn.blobFromImage(
        model_input,
        scalefactor=1.0,
        size=(input_size, input_size),
        mean=IMAGENET_MEAN,
        swapRB=False,
        crop=False,
    )
    for channel_index, std in enumerate(IMAGENET_STD):
        blob[0, channel_index, :, :] /= std
    net.setInput(blob)
    output = net.forward()
    depth = normalize_depth_output(output)
    if letterbox and meta:
        top, left, content_height, content_width = meta
        depth = depth[top : top + content_height, left : left + content_width]
    depth = cv2.resize(depth, (width, height), interpolation=cv2.INTER_CUBIC)
    depth = cv2.normalize(depth, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    depth = edge_aware_filter_depth(
        frame,
        depth,
        edge_filter_strength,
        edge_filter_diameter,
        edge_filter_sigma_color,
        edge_filter_sigma_space,
    )
    if invert:
        depth = 255 - depth

    if color_mode == "magma":
        return cv2.applyColorMap(depth, cv2.COLORMAP_MAGMA)
    if color_mode == "inferno":
        return cv2.applyColorMap(depth, cv2.COLORMAP_INFERNO)
    return cv2.cvtColor(depth, cv2.COLOR_GRAY2BGR)


def letterbox_image(rgb: np.ndarray, input_size: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    height, width = rgb.shape[:2]
    scale = min(input_size / float(width), input_size / float(height))
    content_width = max(1, int(round(width * scale)))
    content_height = max(1, int(round(height * scale)))
    resized = cv2.resize(rgb, (content_width, content_height), interpolation=cv2.INTER_CUBIC)
    canvas = np.full((input_size, input_size, 3), IMAGENET_MEAN, dtype=np.uint8)
    top = (input_size - content_height) // 2
    left = (input_size - content_width) // 2
    canvas[top : top + content_height, left : left + content_width] = resized
    return canvas, (top, left, content_height, content_width)


def edge_aware_filter_depth(
    frame_bgr: np.ndarray,
    depth: np.ndarray,
    strength: float,
    diameter: int,
    sigma_color: float,
    sigma_space: float,
) -> np.ndarray:
    strength = float(np.clip(strength, 0.0, 1.0))
    if strength <= 0:
        return depth
    diameter = max(1, int(diameter))
    if diameter % 2 == 0:
        diameter += 1

    filtered: np.ndarray
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "jointBilateralFilter"):
        guide = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        filtered = cv2.ximgproc.jointBilateralFilter(guide, depth, diameter, sigma_color, sigma_space)
    else:
        filtered = cv2.bilateralFilter(depth, diameter, sigma_color, sigma_space)
    return cv2.addWeighted(depth, 1.0 - strength, filtered, strength, 0)


def edge_filter_mode() -> str:
    if hasattr(cv2, "ximgproc") and hasattr(cv2.ximgproc, "jointBilateralFilter"):
        return "joint-bilateral-rgb"
    return "bilateral-depth-fallback"


def normalize_depth_output(output: np.ndarray) -> np.ndarray:
    depth = np.asarray(output)
    depth = np.squeeze(depth)
    if depth.ndim != 2:
        raise SystemExit(f"Depth Anything output must squeeze to HxW, got shape {output.shape}")
    return depth.astype(np.float32)


def merge_audio(input_path: Path, temp_video: Path, output_path: Path, crf: str) -> None:
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        shutil.copyfile(temp_video, output_path)
        return
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(temp_video),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        str(crf),
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-shortest",
        str(output_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        shutil.copyfile(temp_video, output_path)


def resolve_ffmpeg() -> str | None:
    system = shutil.which("ffmpeg")
    if system:
        return system
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def cleanup_temp(temp_dir: Path, keep_temp: bool) -> None:
    if keep_temp:
        return
    shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
