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
    landmarks: np.ndarray | None = None


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


class MediaPipeFaceDetector(FaceDetector):
    name = "mediapipe_face"

    def __init__(
        self,
        confidence: float,
        nms: float,
        landmark_confidence: float,
        landmark_expand: float,
        max_faces: int,
    ):
        from qai_hub_models.models.mediapipe_face.app import MediaPipeFaceApp
        from qai_hub_models.models.mediapipe_face.model import MediaPipeFace
        from qai_hub_models.utils.asset_loaders import always_answer_prompts

        with always_answer_prompts(True):
            model = MediaPipeFace.from_pretrained(include_detector_postprocessing=False)
        self.app = MediaPipeFaceApp(
            model.face_detector,
            model.face_landmark_detector,
            model.face_detector.include_postprocessing,
            model.face_detector.anchors,
            model.face_detector.get_input_spec(),
            model.face_landmark_detector.get_input_spec(),
            min_detector_face_box_score=confidence,
            nms_iou_threshold=nms,
            min_landmark_score=landmark_confidence,
        )
        self.landmark_expand = max(0.0, landmark_expand)
        self.max_faces = max(1, max_faces)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        selected_boxes, _selected_keypoints, _roi, *landmarks_out = self.app.predict_landmarks_from_image(
            rgb,
            raw_output=True,
        )
        if not selected_boxes:
            return []
        boxes = tensor_to_numpy(selected_boxes[0])
        landmarks = tensor_to_numpy(landmarks_out[0][0]) if landmarks_out and landmarks_out[0] else np.empty((0,))
        detections: list[Detection] = []
        for index, box in enumerate(boxes[: self.max_faces]):
            bbox = xyxy_points_to_xywh(box)
            landmark_points = None
            if landmarks.ndim == 3 and index < landmarks.shape[0] and landmarks[index].size:
                landmark_points = landmarks[index]
                landmark_bbox = landmarks_to_xywh(landmarks[index])
                if landmark_bbox is not None:
                    bbox = expand_box(landmark_bbox, frame.shape[1], frame.shape[0], self.landmark_expand)
            detections.append(Detection(bbox, 1.0, landmark_points))
        return detections


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Detect faces frame-by-frame and anonymize them.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--detector", choices=["auto", "scrfd", "yunet", "mediapipe-face"], default="auto")
    parser.add_argument("--scrfd-model", default="buffalo_l", help="InsightFace model pack.")
    parser.add_argument("--det-size", type=int, default=960, help="Detector input size for SCRFD.")
    parser.add_argument("--yunet-model", default="models/face_detection_yunet_2023mar.onnx")
    parser.add_argument("--mediapipe-landmark-confidence", type=float, default=0.5)
    parser.add_argument("--mediapipe-landmark-expand", type=float, default=0.04)
    parser.add_argument("--mediapipe-max-faces", type=int, default=8)
    parser.add_argument("--confidence", type=float, default=0.72)
    parser.add_argument("--nms", type=float, default=0.3)
    parser.add_argument("--top-k", type=int, default=5000)
    parser.add_argument("--detect-max-side", type=int, default=0, help="Resize frames for detection when max side exceeds this value; 0 keeps original size.")
    parser.add_argument("--expand", type=float, default=0.38, help="Expand detected face boxes by this ratio.")
    parser.add_argument("--hold-frames", type=int, default=8, help="Keep recent tracks to cover missed frames.")
    parser.add_argument("--smooth", type=float, default=0.65, help="Temporal smoothing factor for boxes.")
    parser.add_argument("--mode", choices=["mosaic", "blur", "solid", "mosaic-blur"], default="mosaic")
    parser.add_argument("--solid-color", default="0,0,0", help="BGR solid fill color.")
    parser.add_argument("--solid-alpha", type=float, default=1.0, help="Solid fill opacity from 0.0 to 1.0.")
    parser.add_argument("--mask-shape", choices=["rect", "ellipse", "landmark-hull"], default="ellipse")
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
    if args.detector in ("auto", "mediapipe-face"):
        try:
            return MediaPipeFaceDetector(
                args.confidence,
                args.nms,
                args.mediapipe_landmark_confidence,
                args.mediapipe_landmark_expand,
                args.mediapipe_max_faces,
            )
        except Exception as exc:
            errors.append(f"MediaPipe Face unavailable: {exc}")
            if args.detector == "mediapipe-face":
                raise SystemExit(errors[-1]) from exc

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
    landmark_masks: dict[int, np.ndarray] = {}
    total_faces = 0
    frames_with_faces = 0
    processed_frames = 0
    started_at = time.time()

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            detections = detect_with_scale(detector, frame, args.detect_max_side)
            boxes = [expand_box(det.bbox, width, height, args.expand) for det in detections]
            tracks = update_tracks(tracks, boxes, processed_frames, args.smooth, args.hold_frames)
            landmark_masks = match_landmark_masks_to_tracks(tracks, detections, processed_frames, width, height, args)
            active_boxes = [track.bbox for track in tracks if processed_frames - track.last_seen <= args.hold_frames]
            if active_boxes:
                frames_with_faces += 1
                total_faces += len(boxes)
            output = frame.copy()
            for index, box in enumerate(active_boxes):
                anonymize_face(
                    output,
                    box,
                    landmark_masks.get(index),
                    args.mode,
                    args.mask_shape,
                    args.block,
                    args.blur,
                    parse_solid_color(args.solid_color),
                    args.solid_alpha,
                )
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
        "effect": args.mode,
        "maskShape": args.mask_shape,
        "block": int(args.block),
        "blur": int(args.blur),
        "solidAlpha": round(clamp_float(args.solid_alpha, 0.0, 1.0), 3),
        "elapsedSec": round(time.time() - started_at, 3),
        "output": str(output_path),
    }


def detect_with_scale(detector: FaceDetector, frame: np.ndarray, max_side: int) -> list[Detection]:
    if max_side <= 0:
        return detector.detect(frame)
    height, width = frame.shape[:2]
    source_max_side = max(width, height)
    if source_max_side <= max_side:
        return detector.detect(frame)
    scale = max_side / float(source_max_side)
    resized = cv2.resize(frame, (max(1, int(round(width * scale))), max(1, int(round(height * scale)))), interpolation=cv2.INTER_AREA)
    detections = detector.detect(resized)
    if not detections:
        return []
    inverse = 1.0 / scale
    return [
        Detection(
            (
                detection.bbox[0] * inverse,
                detection.bbox[1] * inverse,
                detection.bbox[2] * inverse,
                detection.bbox[3] * inverse,
            ),
            detection.score,
            scale_landmarks(detection.landmarks, inverse),
        )
        for detection in detections
    ]


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


def tensor_to_numpy(value: object) -> np.ndarray:
    if hasattr(value, "detach"):
        return value.detach().cpu().numpy()  # type: ignore[no-any-return]
    return np.asarray(value)


def xyxy_points_to_xywh(points: np.ndarray) -> tuple[float, float, float, float]:
    array = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    x1 = float(np.nanmin(array[:, 0]))
    y1 = float(np.nanmin(array[:, 1]))
    x2 = float(np.nanmax(array[:, 0]))
    y2 = float(np.nanmax(array[:, 1]))
    return x1, y1, max(1.0, x2 - x1), max(1.0, y2 - y1)


def landmarks_to_xywh(landmarks: np.ndarray) -> tuple[float, float, float, float] | None:
    points = np.asarray(landmarks, dtype=np.float32)
    if points.ndim != 2 or points.shape[1] < 2:
        return None
    finite = np.isfinite(points[:, 0]) & np.isfinite(points[:, 1])
    if points.shape[1] >= 3:
        finite &= np.isfinite(points[:, 2])
    if int(np.count_nonzero(finite)) < 8:
        return None
    return xyxy_points_to_xywh(points[finite, :2])


def match_landmark_masks_to_tracks(
    tracks: list[Track],
    detections: list[Detection],
    frame_index: int,
    width: int,
    height: int,
    args: argparse.Namespace,
) -> dict[int, np.ndarray]:
    if args.mask_shape != "landmark-hull":
        return {}
    masks: dict[int, np.ndarray] = {}
    active_tracks = [track for track in tracks if frame_index - track.last_seen <= args.hold_frames]
    for track_index, track in enumerate(active_tracks):
        best_detection = None
        best_iou = 0.0
        for detection in detections:
            if detection.landmarks is None:
                continue
            score = iou_xywh(track.bbox, expand_box(detection.bbox, width, height, args.expand))
            if score > best_iou:
                best_iou = score
                best_detection = detection
        if best_detection is None or best_iou < 0.12:
            continue
        mask = landmark_hull_mask(best_detection.landmarks, width, height, args.expand)
        if mask is not None:
            masks[track_index] = mask
    return masks


def scale_landmarks(landmarks: np.ndarray | None, scale: float) -> np.ndarray | None:
    if landmarks is None:
        return None
    scaled = np.array(landmarks, dtype=np.float32, copy=True)
    if scaled.ndim == 2 and scaled.shape[1] >= 2:
        scaled[:, :2] *= scale
    return scaled


def anonymize_face(
    frame: np.ndarray,
    bbox: tuple[float, float, float, float],
    landmark_mask: np.ndarray | None,
    mode: str,
    mask_shape: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
    solid_alpha: float,
) -> None:
    x, y, w, h = [int(round(value)) for value in bbox]
    x2 = min(frame.shape[1], x + max(1, w))
    y2 = min(frame.shape[0], y + max(1, h))
    x = max(0, x)
    y = max(0, y)
    if x >= x2 or y >= y2:
        return
    mask = face_mask(frame.shape[:2], (x, y, x2, y2), landmark_mask, mask_shape)
    anonymize_mask(frame, mask, mode, block_size, blur_size, solid_color, solid_alpha)


def face_mask(
    frame_shape: tuple[int, int],
    box: tuple[int, int, int, int],
    landmark_mask: np.ndarray | None,
    mask_shape: str,
) -> np.ndarray:
    height, width = frame_shape
    x1, y1, x2, y2 = box
    if mask_shape == "landmark-hull" and landmark_mask is not None and np.any(landmark_mask):
        return landmark_mask
    mask = np.zeros((height, width), dtype=np.uint8)
    if mask_shape == "rect":
        mask[y1:y2, x1:x2] = 255
        return mask
    center = ((x1 + x2) // 2, (y1 + y2) // 2)
    axes = (max(1, (x2 - x1) // 2), max(1, (y2 - y1) // 2))
    cv2.ellipse(mask, center, axes, 0, 0, 360, 255, -1)
    return mask


def landmark_hull_mask(landmarks: np.ndarray | None, width: int, height: int, expand: float) -> np.ndarray | None:
    if landmarks is None:
        return None
    points = np.asarray(landmarks, dtype=np.float32)
    if points.ndim != 2 or points.shape[1] < 2:
        return None
    finite = np.isfinite(points[:, 0]) & np.isfinite(points[:, 1])
    points = points[finite, :2]
    if len(points) < 8:
        return None
    hull = cv2.convexHull(points.astype(np.float32)).reshape(-1, 2)
    if expand > 0:
        center = hull.mean(axis=0, keepdims=True)
        hull = center + (hull - center) * (1.0 + expand)
    hull[:, 0] = np.clip(hull[:, 0], 0, width - 1)
    hull[:, 1] = np.clip(hull[:, 1], 0, height - 1)
    mask = np.zeros((height, width), dtype=np.uint8)
    cv2.fillConvexPoly(mask, hull.astype(np.int32), 255)
    return mask


def anonymize_mask(
    frame: np.ndarray,
    mask: np.ndarray,
    mode: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
    solid_alpha: float = 1.0,
) -> None:
    if not np.any(mask):
        return
    ys, xs = np.where(mask > 0)
    x, x2 = int(xs.min()), int(xs.max()) + 1
    y, y2 = int(ys.min()), int(ys.max()) + 1
    roi = frame[y:y2, x:x2]
    if mode == "solid":
        alpha = clamp_float(solid_alpha, 0.0, 1.0)
        solid = np.full_like(roi, solid_color)
        roi = solid if alpha >= 1.0 else cv2.addWeighted(roi, 1.0 - alpha, solid, alpha, 0)
    elif mode in ("mosaic", "mosaic-blur"):
        roi = mosaic(roi, block_size)
    if mode in ("blur", "mosaic-blur"):
        kernel = max(3, blur_size | 1)
        roi = cv2.GaussianBlur(roi, (kernel, kernel), 0)
    local_mask = mask[y:y2, x:x2] > 0
    target = frame[y:y2, x:x2]
    target[local_mask] = roi[local_mask]


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, float(value)))


def parse_solid_color(value: str) -> tuple[int, int, int]:
    parts = [int(part.strip()) for part in value.split(",")[:3]]
    while len(parts) < 3:
        parts.append(0)
    return tuple(max(0, min(255, part)) for part in parts[:3])  # type: ignore[return-value]


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


def resolve_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg
    try:
        import imageio_ffmpeg

        bundled = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled and Path(bundled).exists():
            return bundled
    except Exception:
        pass
    raise SystemExit(
        "未找到 ffmpeg，无法导出浏览器可播放的 H.264 视频。"
        "请安装系统 ffmpeg（如 brew install ffmpeg），"
        "或在虚拟环境中执行: pip install imageio-ffmpeg"
    )


def merge_audio(input_path: Path, temp_video: Path, output_path: Path, crf: str) -> None:
    ffmpeg = resolve_ffmpeg()
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
        "-movflags",
        "+faststart",
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
