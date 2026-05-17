#!/usr/bin/env python3
"""Frame-by-frame face anonymization for Videogen source preprocessing."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np


YUNET_MODEL_URL = (
    "https://github.com/opencv/opencv_zoo/raw/main/"
    "models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
)


@dataclass
class Detection:
    bbox: tuple[float, float, float, float]
    score: float


@dataclass
class Track:
    bbox: tuple[float, float, float, float]
    last_seen: int
    hits: int = 1


class FaceDetector:
    name = "base"

    def detect(self, frame: np.ndarray) -> list[Detection]:
        raise NotImplementedError


class InsightFaceDetector(FaceDetector):
    name = "scrfd"

    def __init__(self, model_name: str, det_size: int, confidence: float):
        import insightface

        self.confidence = confidence
        self.app = insightface.app.FaceAnalysis(name=model_name, providers=["CPUExecutionProvider"])
        self.app.prepare(ctx_id=-1, det_size=(det_size, det_size))

    def detect(self, frame: np.ndarray) -> list[Detection]:
        faces = self.app.get(frame)
        detections: list[Detection] = []
        for face in faces:
            score = float(getattr(face, "det_score", 0.0))
            if score < self.confidence:
                continue
            x1, y1, x2, y2 = [float(value) for value in face.bbox]
            detections.append(Detection((x1, y1, x2 - x1, y2 - y1), score))
        return detections


class YuNetDetector(FaceDetector):
    name = "yunet"

    def __init__(self, model_path: Path, confidence: float, nms: float, top_k: int):
        ensure_yunet_model(model_path)
        self.detector = create_yunet_detector(model_path, confidence, nms, top_k)
        self.size: tuple[int, int] | None = None

    def detect(self, frame: np.ndarray) -> list[Detection]:
        height, width = frame.shape[:2]
        if self.size != (width, height):
            self.detector.setInputSize((width, height))
            self.size = (width, height)
        _, faces = self.detector.detect(frame)
        if faces is None:
            return []
        detections: list[Detection] = []
        for face in faces:
            x, y, w, h = [float(value) for value in face[:4]]
            score = float(face[-1])
            detections.append(Detection((x, y, w, h), score))
        return detections


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect faces frame-by-frame and anonymize them.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--detector", choices=["auto", "scrfd", "yunet"], default="auto")
    parser.add_argument("--scrfd-model", default="buffalo_l", help="InsightFace model pack.")
    parser.add_argument("--det-size", type=int, default=960, help="Detector input size for SCRFD.")
    parser.add_argument("--yunet-model", default="models/face_detection_yunet_2023mar.onnx")
    parser.add_argument("--confidence", type=float, default=0.72)
    parser.add_argument("--nms", type=float, default=0.3)
    parser.add_argument("--top-k", type=int, default=5000)
    parser.add_argument("--expand", type=float, default=0.38, help="Expand detected face boxes by this ratio.")
    parser.add_argument("--hold-frames", type=int, default=8, help="Keep recent tracks to cover missed frames.")
    parser.add_argument("--smooth", type=float, default=0.65, help="Temporal smoothing factor for boxes.")
    parser.add_argument("--mode", choices=["mosaic", "blur", "mosaic-blur"], default="mosaic-blur")
    parser.add_argument("--block", type=int, default=14, help="Mosaic block size.")
    parser.add_argument("--blur", type=int, default=45, help="Gaussian blur kernel size.")
    parser.add_argument("--codec", default="mp4v", help="OpenCV temp video codec.")
    parser.add_argument("--crf", default="18", help="ffmpeg x264 CRF for final video.")
    parser.add_argument("--keep-temp", action="store_true")
    parser.add_argument("--strict", action="store_true", help="Fail when no faces are detected.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input video does not exist: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    detector = build_detector(args)
    result = process_video(input_path, output_path, detector, args)
    print(json.dumps(result, ensure_ascii=True))
    return 0


def build_detector(args: argparse.Namespace) -> FaceDetector:
    errors: list[str] = []
    if args.detector in ("auto", "scrfd"):
        try:
            return InsightFaceDetector(args.scrfd_model, args.det_size, args.confidence)
        except Exception as exc:
            errors.append(f"SCRFD unavailable: {exc}")
            if args.detector == "scrfd":
                raise SystemExit(errors[-1]) from exc

    if args.detector in ("auto", "yunet"):
        try:
            return YuNetDetector(Path(args.yunet_model), args.confidence, args.nms, args.top_k)
        except Exception as exc:
            errors.append(f"YuNet unavailable: {exc}")
            if args.detector == "yunet":
                raise SystemExit(errors[-1]) from exc

    raise SystemExit("No usable face detector. " + " | ".join(errors))


def process_video(input_path: Path, output_path: Path, detector: FaceDetector, args: argparse.Namespace) -> dict:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {input_path}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        raise SystemExit("Input video has invalid dimensions.")

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_face_mosaic_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    tracks: list[Track] = []
    total_faces = 0
    frames_with_faces = 0
    processed_frames = 0
    started_at = time.time()

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            detections = detector.detect(frame)
            boxes = [expand_box(det.bbox, width, height, args.expand) for det in detections]
            tracks = update_tracks(tracks, boxes, processed_frames, args.smooth, args.hold_frames)
            active_boxes = [track.bbox for track in tracks if processed_frames - track.last_seen <= args.hold_frames]
            if active_boxes:
                frames_with_faces += 1
                total_faces += len(boxes)
            output = frame.copy()
            for box in active_boxes:
                anonymize_box(output, box, args.mode, args.block, args.blur)
            writer.write(output)
            processed_frames += 1
    finally:
        capture.release()
        writer.release()

    if args.strict and frames_with_faces == 0:
        cleanup_temp(temp_dir, args.keep_temp)
        raise SystemExit("No faces detected; strict mode refused to produce output.")

    merge_audio(input_path, temp_video, output_path, args.crf)
    cleanup_temp(temp_dir, args.keep_temp)
    return {
        "detector": detector.name,
        "frames": processed_frames,
        "sourceFrameCount": frame_count,
        "framesWithFaces": frames_with_faces,
        "detectedFaces": total_faces,
        "width": width,
        "height": height,
        "fps": fps,
        "durationSec": round(processed_frames / fps, 3) if fps else None,
        "elapsedSec": round(time.time() - started_at, 3),
        "output": str(output_path),
    }


def update_tracks(
    tracks: list[Track],
    boxes: list[tuple[float, float, float, float]],
    frame_index: int,
    smooth: float,
    hold_frames: int,
) -> list[Track]:
    assigned: set[int] = set()
    for box in boxes:
        best_index = -1
        best_iou = 0.0
        for index, track in enumerate(tracks):
            if index in assigned:
                continue
            score = iou_xywh(box, track.bbox)
            if score > best_iou:
                best_iou = score
                best_index = index
        if best_index >= 0 and best_iou >= 0.2:
            track = tracks[best_index]
            track.bbox = smooth_box(track.bbox, box, smooth)
            track.last_seen = frame_index
            track.hits += 1
            assigned.add(best_index)
        else:
            tracks.append(Track(box, frame_index))
            assigned.add(len(tracks) - 1)
    return [track for track in tracks if frame_index - track.last_seen <= hold_frames]


def expand_box(
    bbox: tuple[float, float, float, float],
    width: int,
    height: int,
    expand: float,
) -> tuple[float, float, float, float]:
    x, y, w, h = bbox
    pad_x = w * expand
    pad_y = h * expand
    x1 = max(0.0, x - pad_x)
    y1 = max(0.0, y - pad_y)
    x2 = min(float(width), x + w + pad_x)
    y2 = min(float(height), y + h + pad_y)
    return x1, y1, max(1.0, x2 - x1), max(1.0, y2 - y1)


def anonymize_box(
    frame: np.ndarray,
    bbox: tuple[float, float, float, float],
    mode: str,
    block_size: int,
    blur_size: int,
) -> None:
    x, y, w, h = [int(round(value)) for value in bbox]
    x2 = min(frame.shape[1], x + max(1, w))
    y2 = min(frame.shape[0], y + max(1, h))
    x = max(0, x)
    y = max(0, y)
    if x >= x2 or y >= y2:
        return
    roi = frame[y:y2, x:x2]
    if mode in ("mosaic", "mosaic-blur"):
        roi = mosaic(roi, block_size)
    if mode in ("blur", "mosaic-blur"):
        kernel = max(3, blur_size | 1)
        roi = cv2.GaussianBlur(roi, (kernel, kernel), 0)
    frame[y:y2, x:x2] = roi


def mosaic(roi: np.ndarray, block_size: int) -> np.ndarray:
    height, width = roi.shape[:2]
    small_w = max(1, width // max(2, block_size))
    small_h = max(1, height // max(2, block_size))
    small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST)


def smooth_box(
    previous: tuple[float, float, float, float],
    current: tuple[float, float, float, float],
    alpha: float,
) -> tuple[float, float, float, float]:
    alpha = min(0.95, max(0.0, alpha))
    return tuple(alpha * p + (1.0 - alpha) * c for p, c in zip(previous, current))  # type: ignore[return-value]


def iou_xywh(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def ensure_yunet_model(model_path: Path) -> None:
    if model_path.exists():
        return
    model_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(YUNET_MODEL_URL, model_path)
    except Exception as exc:
        raise RuntimeError(f"Could not download YuNet model from {YUNET_MODEL_URL}: {exc}") from exc


def create_yunet_detector(model_path: Path, confidence: float, nms: float, top_k: int):
    if hasattr(cv2, "FaceDetectorYN_create"):
        return cv2.FaceDetectorYN_create(str(model_path), "", (320, 320), confidence, nms, top_k)
    if hasattr(cv2, "FaceDetectorYN") and hasattr(cv2.FaceDetectorYN, "create"):
        return cv2.FaceDetectorYN.create(str(model_path), "", (320, 320), confidence, nms, top_k)
    raise RuntimeError("This OpenCV build does not expose FaceDetectorYN. Install opencv-python>=4.10.")


def merge_audio(input_path: Path, temp_video: Path, output_path: Path, crf: str) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        shutil.copyfile(temp_video, output_path)
        return
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(temp_video),
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-shortest",
        str(output_path),
    ]
    subprocess.run(command, check=True)


def cleanup_temp(temp_dir: Path, keep_temp: bool) -> None:
    if keep_temp:
        return
    shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
