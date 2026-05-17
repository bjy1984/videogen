#!/usr/bin/env python3
"""User-guided brand/logo/text masking for Videogen source preprocessing."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np


Rect = tuple[float, float, float, float]


@dataclass
class Keyframe:
    time: float
    frame_index: int
    source: str
    rect: Rect


@dataclass
class TrackSpec:
    id: str
    label: str
    target_type: str
    effect: str
    track_mode: str
    expand_ratio: float
    confidence_threshold: float
    keyframes: list[Keyframe]


@dataclass
class TrackState:
    rect: Rect
    previous_gray: np.ndarray | None = None
    anchor_gray: np.ndarray | None = None
    anchor_rect: Rect | None = None
    tracker: Any | None = None


@dataclass
class FrameIssue:
    track_id: str
    frame_index: int
    time: float
    severity: str
    reason: str
    confidence: float | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply user-guided brand/logo/text masks frame-by-frame.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--spec", required=True, help="JSON spec with brand mask tracks.")
    parser.add_argument("--codec", default="mp4v", help="OpenCV temp video codec.")
    parser.add_argument("--crf", default="18", help="ffmpeg x264 CRF for final video.")
    parser.add_argument("--block", type=int, default=20, help="Mosaic block size.")
    parser.add_argument("--blur", type=int, default=51, help="Gaussian blur kernel size.")
    parser.add_argument("--solid-color", default="0,0,0", help="BGR solid fill color.")
    parser.add_argument("--block-on-red", action="store_true", help="Exit non-zero if any red issue is produced.")
    parser.add_argument("--keep-temp", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    spec_path = Path(args.spec).expanduser().resolve()
    if not input_path.exists():
        raise SystemExit(f"Input video does not exist: {input_path}")
    if not spec_path.exists():
        raise SystemExit(f"Mask spec does not exist: {spec_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    result = process_video(input_path, output_path, spec_path, args)
    print(json.dumps(result, ensure_ascii=True))
    if args.block_on_red and result["blockedFrames"] > 0:
        raise SystemExit(f"Brand mask has {result['blockedFrames']} red frames; add correction keyframes.")
    return 0


def process_video(input_path: Path, output_path: Path, spec_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {input_path}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        raise SystemExit("Input video has invalid dimensions.")

    spec = json.loads(spec_path.read_text("utf8"))
    tracks = parse_tracks(spec, fps)
    if not tracks:
        raise SystemExit("Mask spec has no usable tracks.")

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_brand_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    states: dict[str, TrackState] = {}
    issues: list[FrameIssue] = []
    processed_frames = 0
    masked_frames = 0
    started_at = time.time()
    solid_color = parse_solid_color(args.solid_color)

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            frame_time = processed_frames / fps if fps else 0.0
            output = frame.copy()
            frame_masked = False

            for track in tracks:
                previous_state = states.get(track.id)
                rect, confidence = resolve_track_rect(track, previous_state, frame, gray, processed_frames, frame_time)
                if rect is None:
                    continue
                exact = exact_keyframe(track, processed_frames, frame_time)
                if confidence is not None and confidence < track.confidence_threshold:
                    has_right_anchor = next_keyframe(track, processed_frames) is not None
                    severity = issue_severity(confidence, track.confidence_threshold, has_right_anchor)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity=severity,
                            reason=f"{track.label} tracking confidence is low.",
                            confidence=round(confidence, 3),
                        )
                    )
                apply_mask(output, expand_rect(rect, track.expand_ratio), track.effect, args.block, args.blur, solid_color)
                states[track.id] = TrackState(
                    rect=rect,
                    previous_gray=gray,
                    anchor_gray=gray if exact else previous_state.anchor_gray if previous_state else gray,
                    anchor_rect=rect if exact else previous_state.anchor_rect if previous_state else rect,
                    tracker=create_cv_tracker(frame, rect) if exact or not previous_state or previous_state.tracker is None else previous_state.tracker,
                )
                frame_masked = True

            if frame_masked:
                masked_frames += 1
            writer.write(output)
            processed_frames += 1
    finally:
        capture.release()
        writer.release()

    merge_audio(input_path, temp_video, output_path, args.crf)
    cleanup_temp(temp_dir, args.keep_temp)

    error_frames = sorted({issue.frame_index for issue in issues if issue.severity == "error"})
    warning_frames = sorted({issue.frame_index for issue in issues if issue.severity == "warning"})
    return {
        "frameCount": processed_frames,
        "sourceFrameCount": frame_count,
        "maskedFrames": masked_frames,
        "trackCount": len(tracks),
        "manualKeyframes": sum(1 for track in tracks for keyframe in track.keyframes if keyframe.source == "manual"),
        "correctedKeyframes": sum(1 for track in tracks for keyframe in track.keyframes if keyframe.source == "correction"),
        "warningFrames": len(warning_frames),
        "blockedFrames": len(error_frames),
        "width": width,
        "height": height,
        "fps": fps,
        "durationSec": round(processed_frames / fps, 3) if fps else None,
        "elapsedSec": round(time.time() - started_at, 3),
        "output": str(output_path),
        "issues": [issue_to_dict(issue) for issue in compact_issues(issues)],
    }


def parse_tracks(spec: Any, fps: float) -> list[TrackSpec]:
    raw_tracks = spec.get("tracks", spec) if isinstance(spec, dict) else spec
    if not isinstance(raw_tracks, list):
        return []
    tracks: list[TrackSpec] = []
    for raw in raw_tracks:
        if not isinstance(raw, dict):
            continue
        keyframes = parse_keyframes(raw.get("keyframes"), fps)
        if not keyframes:
            continue
        tracks.append(
            TrackSpec(
                id=str(raw.get("id") or f"track_{len(tracks) + 1}"),
                label=str(raw.get("label") or f"Mask {len(tracks) + 1}"),
                target_type=str(raw.get("targetType") or "logo"),
                effect=str(raw.get("effect") or ("solid" if raw.get("targetType") == "text" else "mosaic")),
                track_mode=str(raw.get("trackMode") or "planar"),
                expand_ratio=float(raw.get("expandRatio") if raw.get("expandRatio") is not None else 0.16),
                confidence_threshold=float(raw.get("confidenceThreshold") if raw.get("confidenceThreshold") is not None else 0.45),
                keyframes=keyframes,
            )
        )
    return tracks


def parse_keyframes(raw_keyframes: Any, fps: float) -> list[Keyframe]:
    if not isinstance(raw_keyframes, list):
        return []
    keyframes: list[Keyframe] = []
    for raw in raw_keyframes:
        if not isinstance(raw, dict):
            continue
        shape = raw.get("shape")
        if not isinstance(shape, dict) or shape.get("type") != "rect":
            continue
        rect = (
            clamp01(float(shape.get("x", 0.0))),
            clamp01(float(shape.get("y", 0.0))),
            clamp01(float(shape.get("width", 0.0))),
            clamp01(float(shape.get("height", 0.0))),
        )
        if rect[2] <= 0.0 or rect[3] <= 0.0:
            continue
        frame_index = raw.get("frameIndex")
        time_value = float(raw.get("time", 0.0) or 0.0)
        if isinstance(frame_index, int) and frame_index >= 0:
            index = frame_index
        else:
            index = max(0, int(round(time_value * fps)))
        keyframes.append(Keyframe(time=time_value, frame_index=index, source=str(raw.get("source") or "manual"), rect=rect))
    return sorted(keyframes, key=lambda item: (item.frame_index, item.time))


def resolve_track_rect(
    track: TrackSpec,
    state: TrackState | None,
    frame: np.ndarray,
    gray: np.ndarray,
    frame_index: int,
    frame_time: float,
) -> tuple[Rect | None, float | None]:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return exact.rect, 1.0

    if track.track_mode == "manual":
        return None, None

    if track.track_mode == "static":
        return nearest_track_rect(track, frame_index), 1.0

    interpolated = interpolate_rect(track, frame_index)
    if track.track_mode == "interpolate":
        return interpolated or nearest_track_rect(track, frame_index), 0.9

    if state and state.previous_gray is not None:
        tracked, score = track_with_cv_tracker(state.tracker, frame, state.rect)
        if tracked is not None:
            return tracked, score
        anchor_gray = state.anchor_gray if state.anchor_gray is not None else state.previous_gray
        anchor_rect = state.anchor_rect if state.anchor_rect is not None else state.rect
        if track.track_mode == "planar":
            tracked, score = track_with_template(anchor_gray, gray, anchor_rect, state.rect)
            if tracked is not None and score >= track.confidence_threshold * 0.75:
                return tracked, score
            tracked, score = track_with_lk(state.previous_gray, gray, state.rect)
            if tracked is None or score < track.confidence_threshold * 0.75:
                tracked, score = track_with_features(state.previous_gray, gray, state.rect)
        else:
            tracked, score = track_with_template(anchor_gray, gray, anchor_rect, state.rect)
            if tracked is None or score < track.confidence_threshold * 0.75:
                tracked, score = track_with_lk(state.previous_gray, gray, state.rect)
            if tracked is None or score < track.confidence_threshold * 0.75:
                tracked, score = track_with_features(state.previous_gray, gray, state.rect)
        if tracked is not None:
            return tracked, score

    return interpolated or nearest_track_rect(track, frame_index), 0.5 if interpolated else 0.35


def issue_severity(confidence: float, threshold: float, has_right_anchor: bool) -> str:
    if has_right_anchor:
        return "warning"
    return "warning" if confidence >= threshold * 0.72 else "error"


def exact_keyframe(track: TrackSpec, frame_index: int, frame_time: float) -> Keyframe | None:
    for keyframe in track.keyframes:
        if keyframe.frame_index == frame_index or abs(keyframe.time - frame_time) < 0.5 / 30:
            return keyframe
    return None


def next_keyframe(track: TrackSpec, frame_index: int) -> Keyframe | None:
    return next((keyframe for keyframe in track.keyframes if keyframe.frame_index > frame_index), None)


def nearest_track_rect(track: TrackSpec, frame_index: int) -> Rect:
    return min(track.keyframes, key=lambda keyframe: abs(keyframe.frame_index - frame_index)).rect


def interpolate_rect(track: TrackSpec, frame_index: int) -> Rect | None:
    left = None
    right = None
    for keyframe in track.keyframes:
        if keyframe.frame_index <= frame_index:
            left = keyframe
        if keyframe.frame_index > frame_index:
            right = keyframe
            break
    if not left or not right:
        return None
    span = max(1, right.frame_index - left.frame_index)
    t = (frame_index - left.frame_index) / span
    return tuple(left.rect[index] + (right.rect[index] - left.rect[index]) * t for index in range(4))  # type: ignore[return-value]


def track_with_features(previous: np.ndarray, current: np.ndarray, rect: Rect) -> tuple[Rect | None, float]:
    prev_crop, prev_offset = crop_from_rect(previous, rect, pad=0.15)
    search_crop, search_offset = crop_from_rect(current, rect, pad=0.55)
    if prev_crop.size == 0 or search_crop.size == 0:
        return None, 0.0

    detector, norm = create_feature_detector()
    kp1, des1 = detector.detectAndCompute(prev_crop, None)
    kp2, des2 = detector.detectAndCompute(search_crop, None)
    if des1 is None or des2 is None or len(kp1) < 6 or len(kp2) < 6:
        return None, 0.0

    matcher = cv2.BFMatcher(norm)
    matches = matcher.knnMatch(des1, des2, k=2)
    good = []
    for pair in matches:
        if len(pair) < 2:
            continue
        first, second = pair
        if first.distance < 0.75 * second.distance:
            good.append(first)
    if len(good) < 6:
        return None, 0.0

    src = np.float32([kp1[match.queryIdx].pt for match in good]).reshape(-1, 1, 2)
    dst = np.float32([kp2[match.trainIdx].pt for match in good]).reshape(-1, 1, 2)
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if matrix is None or inliers is None:
        return None, 0.0

    x, y, w, h = rect_to_pixels(rect, previous.shape[1], previous.shape[0])
    local_corners = np.float32(
        [
            [x - prev_offset[0], y - prev_offset[1]],
            [x + w - prev_offset[0], y - prev_offset[1]],
            [x + w - prev_offset[0], y + h - prev_offset[1]],
            [x - prev_offset[0], y + h - prev_offset[1]],
        ]
    ).reshape(-1, 1, 2)
    transformed = cv2.transform(local_corners, matrix).reshape(-1, 2)
    transformed[:, 0] += search_offset[0]
    transformed[:, 1] += search_offset[1]
    next_rect = pixels_to_rect(points_to_bbox(transformed), current.shape[1], current.shape[0])
    score = float(np.count_nonzero(inliers)) / max(1, len(good))
    return validate_rect(next_rect, rect), score


def track_with_lk(previous: np.ndarray, current: np.ndarray, rect: Rect) -> tuple[Rect | None, float]:
    x, y, w, h = rect_to_pixels(rect, previous.shape[1], previous.shape[0])
    mask = np.zeros_like(previous)
    mask[y : y + h, x : x + w] = 255
    points = cv2.goodFeaturesToTrack(previous, maxCorners=80, qualityLevel=0.01, minDistance=5, mask=mask)
    if points is None or len(points) < 4:
        return None, 0.0
    next_points, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None)
    if next_points is None or status is None:
        return None, 0.0
    good_prev = points[status.reshape(-1) == 1]
    good_next = next_points[status.reshape(-1) == 1]
    if len(good_prev) < 4:
        return None, 0.0
    matrix, inliers = cv2.estimateAffinePartial2D(good_prev, good_next, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if matrix is None or inliers is None:
        return None, 0.0
    corners = np.float32([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]).reshape(-1, 1, 2)
    transformed = cv2.transform(corners, matrix).reshape(-1, 2)
    next_rect = pixels_to_rect(points_to_bbox(transformed), current.shape[1], current.shape[0])
    score = float(np.count_nonzero(inliers)) / max(1, len(good_prev))
    return validate_rect(next_rect, rect), score


def create_cv_tracker(frame: np.ndarray, rect: Rect) -> Any | None:
    if not hasattr(cv2, "TrackerMIL_create"):
        return None
    x, y, w, h = rect_to_pixels(rect, frame.shape[1], frame.shape[0])
    tracker = cv2.TrackerMIL_create()
    try:
        tracker.init(frame, (x, y, w, h))
        return tracker
    except cv2.error:
        return None


def track_with_cv_tracker(tracker: Any | None, current: np.ndarray, previous_rect: Rect) -> tuple[Rect | None, float]:
    if tracker is None:
        return None, 0.0
    try:
        ok, bbox = tracker.update(current)
    except cv2.error:
        return None, 0.0
    if not ok:
        return None, 0.0
    x, y, w, h = bbox
    candidate = pixels_to_rect((int(round(x)), int(round(y)), int(round(w)), int(round(h))), current.shape[1], current.shape[0])
    return validate_rect(candidate, previous_rect), 0.76


def track_with_template(template_frame: np.ndarray, current: np.ndarray, template_rect: Rect, search_rect: Rect | None = None) -> tuple[Rect | None, float]:
    search_rect = search_rect or template_rect
    template_crop, template_offset = crop_from_rect(template_frame, template_rect, pad=0.08)
    search_crop, search_offset = crop_from_rect(current, search_rect, pad=0.9)
    if template_crop.size == 0 or search_crop.size == 0:
        return None, 0.0
    if template_crop.shape[0] < 10 or template_crop.shape[1] < 10:
        return None, 0.0
    if search_crop.shape[0] < template_crop.shape[0] or search_crop.shape[1] < template_crop.shape[1]:
        return None, 0.0

    template_signal = matching_signal(template_crop)
    search_signal = matching_signal(search_crop)
    if float(np.std(template_signal)) < 4.0:
        return None, 0.0

    work_scale = min(1.0, 420.0 / max(search_signal.shape[:2]))
    if work_scale < 1.0:
        template_signal = resize_for_matching(template_signal, work_scale)
        search_signal = resize_for_matching(search_signal, work_scale)

    x, y, w, h = rect_to_pixels(template_rect, template_frame.shape[1], template_frame.shape[0])
    best_rect: Rect | None = None
    best_score = 0.0
    rect_offset_x = x - template_offset[0]
    rect_offset_y = y - template_offset[1]
    for scale in (0.94, 1.0, 1.06):
        scaled_w = max(8, int(round(template_signal.shape[1] * scale)))
        scaled_h = max(8, int(round(template_signal.shape[0] * scale)))
        if scaled_w > search_signal.shape[1] or scaled_h > search_signal.shape[0]:
            continue
        scaled_template = cv2.resize(template_signal, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        score_map = cv2.matchTemplate(search_signal, scaled_template, cv2.TM_CCOEFF_NORMED)
        _, max_value, _, max_location = cv2.minMaxLoc(score_map)
        original_match_x = max_location[0] / work_scale
        original_match_y = max_location[1] / work_scale
        candidate_pixels = (
            int(round(search_offset[0] + original_match_x + rect_offset_x * scale)),
            int(round(search_offset[1] + original_match_y + rect_offset_y * scale)),
            max(1, int(round(w * scale))),
            max(1, int(round(h * scale))),
        )
        candidate = validate_rect(pixels_to_rect(candidate_pixels, current.shape[1], current.shape[0]), search_rect)
        if candidate is not None and max_value > best_score:
            best_rect = candidate
            best_score = float(max_value)

    return best_rect, best_score


def matching_signal(gray: np.ndarray) -> np.ndarray:
    equalized = cv2.equalizeHist(gray)
    edges = cv2.Canny(equalized, 50, 150)
    edge_density = float(np.count_nonzero(edges)) / max(1, edges.size)
    if edge_density > 0.015:
        return edges
    return equalized


def resize_for_matching(gray: np.ndarray, scale: float) -> np.ndarray:
    width = max(8, int(round(gray.shape[1] * scale)))
    height = max(8, int(round(gray.shape[0] * scale)))
    return cv2.resize(gray, (width, height), interpolation=cv2.INTER_AREA)


def create_feature_detector():
    if hasattr(cv2, "SIFT_create"):
        return cv2.SIFT_create(nfeatures=260), cv2.NORM_L2
    return cv2.ORB_create(nfeatures=360), cv2.NORM_HAMMING


def crop_from_rect(gray: np.ndarray, rect: Rect, pad: float) -> tuple[np.ndarray, tuple[int, int]]:
    x, y, w, h = rect_to_pixels(expand_rect(rect, pad), gray.shape[1], gray.shape[0])
    return gray[y : y + h, x : x + w], (x, y)


def points_to_bbox(points: np.ndarray) -> tuple[int, int, int, int]:
    x1 = int(np.floor(np.min(points[:, 0])))
    y1 = int(np.floor(np.min(points[:, 1])))
    x2 = int(np.ceil(np.max(points[:, 0])))
    y2 = int(np.ceil(np.max(points[:, 1])))
    return x1, y1, max(1, x2 - x1), max(1, y2 - y1)


def validate_rect(candidate: Rect | None, previous: Rect) -> Rect | None:
    if candidate is None:
        return None
    _, _, pw, ph = previous
    x, y, w, h = candidate
    if w <= 0.004 or h <= 0.004:
        return None
    area_ratio = (w * h) / max(0.000001, pw * ph)
    if area_ratio < 0.18 or area_ratio > 4.5:
        return None
    return clamp_rect((x, y, w, h))


def apply_mask(
    frame: np.ndarray,
    rect: Rect,
    effect: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
) -> None:
    x, y, w, h = rect_to_pixels(rect, frame.shape[1], frame.shape[0])
    if w <= 0 or h <= 0:
        return
    roi = frame[y : y + h, x : x + w]
    if effect == "solid":
        roi[:] = solid_color
        return
    if effect == "blur":
        kernel = max(3, blur_size | 1)
        frame[y : y + h, x : x + w] = cv2.GaussianBlur(roi, (kernel, kernel), 0)
        return
    frame[y : y + h, x : x + w] = mosaic(roi, block_size)


def mosaic(roi: np.ndarray, block_size: int) -> np.ndarray:
    height, width = roi.shape[:2]
    small_w = max(1, width // max(2, block_size))
    small_h = max(1, height // max(2, block_size))
    small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST)


def expand_rect(rect: Rect, expand: float) -> Rect:
    x, y, w, h = rect
    pad_x = w * max(0.0, expand)
    pad_y = h * max(0.0, expand)
    return clamp_rect((x - pad_x, y - pad_y, w + pad_x * 2, h + pad_y * 2))


def clamp_rect(rect: Rect) -> Rect:
    x, y, w, h = rect
    x = clamp01(x)
    y = clamp01(y)
    w = min(max(0.0, w), 1.0 - x)
    h = min(max(0.0, h), 1.0 - y)
    return x, y, w, h


def rect_to_pixels(rect: Rect, width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = clamp_rect(rect)
    px = int(round(x * width))
    py = int(round(y * height))
    pw = max(1, int(round(w * width)))
    ph = max(1, int(round(h * height)))
    if px + pw > width:
        pw = max(1, width - px)
    if py + ph > height:
        ph = max(1, height - py)
    return px, py, pw, ph


def pixels_to_rect(bbox: tuple[int, int, int, int], width: int, height: int) -> Rect:
    x, y, w, h = bbox
    return clamp_rect((x / width, y / height, w / width, h / height))


def parse_solid_color(value: str) -> tuple[int, int, int]:
    parts = [int(part.strip()) for part in value.split(",")[:3]]
    while len(parts) < 3:
        parts.append(0)
    return tuple(max(0, min(255, part)) for part in parts[:3])  # type: ignore[return-value]


def compact_issues(issues: list[FrameIssue], limit: int = 120) -> list[FrameIssue]:
    if len(issues) <= limit:
        return issues
    return issues[:limit]


def issue_to_dict(issue: FrameIssue) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "trackId": issue.track_id,
        "frameIndex": issue.frame_index,
        "time": issue.time,
        "severity": issue.severity,
        "reason": issue.reason,
    }
    if issue.confidence is not None:
        payload["confidence"] = issue.confidence
    return payload


def clamp01(value: float) -> float:
    if math.isnan(value) or math.isinf(value):
        return 0.0
    return min(1.0, max(0.0, value))


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
