#!/usr/bin/env python3
"""Convert a video to grayscale with OpenCV while preserving browser playback."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a video to grayscale with OpenCV.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resolution", choices=["source", "720p", "1080p"], default="source")
    parser.add_argument("--fps", type=float, default=0.0, help="0 keeps source FPS.")
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

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_grayscale_"))
    temp_video = temp_dir / "grayscale_no_audio.mp4"
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
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            grayscale_frame = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            writer.write(grayscale_frame)
            processed_frames += 1
    finally:
        capture.release()
        writer.release()

    merge_audio(input_path, temp_video, output_path, args.crf)
    cleanup_temp(temp_dir, args.keep_temp)
    return {
        "algorithm": "opencv-grayscale",
        "frameCount": processed_frames,
        "sourceFrameCount": frame_count,
        "width": width,
        "height": height,
        "fps": fps,
        "durationSec": round(processed_frames / fps, 3) if fps else None,
        "elapsedSec": round(time.time() - started_at, 3),
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
