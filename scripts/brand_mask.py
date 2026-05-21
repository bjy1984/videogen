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

DEFAULT_EXPAND_RATIO = 0.06
MAX_EXPAND_RATIO = 0.12
MIN_TRACKED_AREA_RATIO = 0.42
MAX_TRACKED_AREA_RATIO = 1.85
MIN_ANCHOR_AREA_RATIO = 0.28
MAX_ANCHOR_AREA_RATIO = 2.35
MAX_ASPECT_RATIO_CHANGE = 1.75
MAX_CENTER_SHIFT = 0.22
MIN_RECOVERY_SCORE = 0.5
MAX_FRAME_SCALE_STEP = 0.08
SIZE_SMOOTHING = 0.82
CENTER_SMOOTHING = 0.35


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
    strength: float
    track_mode: str
    scale_mode: str
    expand_ratio: float
    confidence_threshold: float
    keyframes: list[Keyframe]


@dataclass
class TrackState:
    rect: Rect
    previous_gray: np.ndarray | None = None
    anchor_gray: np.ndarray | None = None
    anchor_rect: Rect | None = None
    previous_hist: np.ndarray | None = None
    anchor_hist: np.ndarray | None = None
    tracker: Any | None = None
    lost_count: int = 0
    last_source: str = "manual"


@dataclass
class FrameIssue:
    track_id: str
    frame_index: int
    time: float
    severity: str
    reason: str
    confidence: float | None = None


@dataclass
class TrackingCandidate:
    rect: Rect
    confidence: float
    source: str
    raw_score: float
    color_similarity: float
    path_similarity: float = 0.0
    consensus: float = 0.0
    recovered: bool = False


@dataclass
class TrackingDecision:
    rect: Rect | None
    confidence: float | None = None
    reject_reason: str | None = None
    source: str = "none"
    recovered: bool = False


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
    parser.add_argument("--edge-strength", type=float, default=1.0, help="Deprecated; masks are applied at full strength.")
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
    skipped_low_confidence_frames: set[int] = set()
    skipped_scale_frames: set[int] = set()
    skipped_tracking_frames: set[int] = set()
    recovered_frames: set[int] = set()
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
                decision = resolve_track_rect(track, previous_state, frame, gray, processed_frames, frame_time)
                if decision.reject_reason:
                    skipped_tracking_frames.add(processed_frames)
                    if is_scale_rejection(decision.reject_reason):
                        skipped_scale_frames.add(processed_frames)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity="error",
                            reason=f"{track.label} {decision.reject_reason}，已跳过该帧。",
                            confidence=round(decision.confidence, 3) if decision.confidence is not None else None,
                        )
                    )
                    mark_track_lost(states, track, previous_state)
                    continue
                rect = decision.rect
                if rect is None:
                    mark_track_lost(states, track, previous_state)
                    continue
                exact = exact_keyframe(track, processed_frames, frame_time)
                if decision.confidence is not None and decision.confidence < track.confidence_threshold:
                    skipped_low_confidence_frames.add(processed_frames)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity="error",
                            reason=f"{track.label} 追踪置信度不足，已跳过该帧。",
                            confidence=round(decision.confidence, 3),
                        )
                    )
                    if not exact:
                        mark_track_lost(states, track, previous_state)
                        continue
                if previous_state and not exact:
                    rect = stabilize_rect(rect, previous_state.rect, decision.confidence, track.scale_mode, previous_state.anchor_rect)
                apply_track_mask(output, expand_rect(rect, track.expand_ratio), track, args.block, args.blur, solid_color)
                if decision.recovered:
                    recovered_frames.add(processed_frames)
                current_hist = color_hist(frame, rect)
                states[track.id] = TrackState(
                    rect=rect,
                    previous_gray=gray,
                    anchor_gray=gray if exact else previous_state.anchor_gray if previous_state else gray,
                    anchor_rect=rect if exact else previous_state.anchor_rect if previous_state else rect,
                    previous_hist=current_hist,
                    anchor_hist=current_hist if exact else previous_state.anchor_hist if previous_state and previous_state.anchor_hist is not None else current_hist,
                    tracker=create_cv_tracker(frame, rect) if exact or not previous_state or previous_state.tracker is None else previous_state.tracker,
                    lost_count=0,
                    last_source=decision.source,
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
        "skippedLowConfidenceFrames": len(skipped_low_confidence_frames),
        "skippedScaleFrames": len(skipped_scale_frames),
        "skippedTrackingFrames": len(skipped_tracking_frames),
        "recoveredFrames": len(recovered_frames),
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
                strength=normalize_mask_strength(raw.get("strength")),
                track_mode=str(raw.get("trackMode") or "planar"),
                scale_mode=parse_scale_mode(raw.get("scaleMode")),
                expand_ratio=clamp_float(
                    float(raw.get("expandRatio") if raw.get("expandRatio") is not None else DEFAULT_EXPAND_RATIO),
                    0.0,
                    MAX_EXPAND_RATIO,
                ),
                confidence_threshold=float(raw.get("confidenceThreshold") if raw.get("confidenceThreshold") is not None else 0.45),
                keyframes=keyframes,
            )
        )
    return tracks


def parse_scale_mode(value: Any) -> str:
    if value in {"locked", "slow-zoom", "free"}:
        return str(value)
    return "locked"


def normalize_mask_strength(value: Any, fallback: float = 0.85) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = fallback
    return clamp_float(numeric, 0.2, 1.0)


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
) -> TrackingDecision:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return TrackingDecision(rect=exact.rect, confidence=1.0, source="manual")

    if track.track_mode == "manual":
        return TrackingDecision(rect=None)

    if track.track_mode == "static":
        return TrackingDecision(rect=nearest_track_rect(track, frame_index), confidence=1.0, source="static")

    interpolated = interpolate_rect(track, frame_index)
    if track.track_mode == "interpolate":
        return TrackingDecision(rect=interpolated or nearest_track_rect(track, frame_index), confidence=0.9, source="interpolate")

    candidates: list[TrackingCandidate] = []
    reject_reason = None
    reject_score = 0.0
    if state and state.previous_gray is not None:
        anchor_gray = state.anchor_gray if state.anchor_gray is not None else state.previous_gray
        anchor_rect = state.anchor_rect if state.anchor_rect is not None else state.rect
        min_method_score = track.confidence_threshold * 0.55

        tracked, score, reason = track_with_cv_tracker(state.tracker, frame, state.rect)
        candidate, reject_reason, reject_score = build_candidate_or_reject(
            "tracker",
            tracked,
            score,
            reason,
            frame,
            state,
            anchor_rect,
            reject_reason,
            reject_score,
            interpolated,
        )
        if candidate:
            candidates.append(candidate)

        local_template = track_with_template(
            anchor_gray,
            gray,
            anchor_rect,
            state.rect,
            search_pad=0.95,
            scales=(0.86, 0.92, 1.0, 1.08, 1.16),
        )
        candidate, reject_reason, reject_score = build_candidate_or_reject(
            "template",
            *local_template,
            frame,
            state,
            anchor_rect,
            reject_reason,
            reject_score,
            interpolated,
        )
        if candidate:
            candidates.append(candidate)

        if track.track_mode == "planar":
            tracked, score, reason = track_with_lk(state.previous_gray, gray, state.rect)
            candidate, reject_reason, reject_score = build_candidate_or_reject(
                "lk",
                tracked,
                score,
                reason,
                frame,
                state,
                anchor_rect,
                reject_reason,
                reject_score,
                interpolated,
            )
            if candidate:
                candidates.append(candidate)
            if tracked is None or score < min_method_score:
                reject_reason, reject_score = remember_rejection(reject_reason, reject_score, reason, score)
                tracked, score, reason = track_with_features(state.previous_gray, gray, state.rect)
            candidate, reject_reason, reject_score = build_candidate_or_reject(
                "features",
                tracked,
                score,
                reason,
                frame,
                state,
                anchor_rect,
                reject_reason,
                reject_score,
                interpolated,
            )
            if candidate:
                candidates.append(candidate)
        else:
            tracked, score, reason = track_with_lk(state.previous_gray, gray, state.rect)
            candidate, reject_reason, reject_score = build_candidate_or_reject(
                "lk",
                tracked,
                score,
                reason,
                frame,
                state,
                anchor_rect,
                reject_reason,
                reject_score,
                interpolated,
            )
            if candidate:
                candidates.append(candidate)
            if tracked is None or score < min_method_score:
                reject_reason, reject_score = remember_rejection(reject_reason, reject_score, reason, score)
                tracked, score, reason = track_with_features(state.previous_gray, gray, state.rect)
                candidate, reject_reason, reject_score = build_candidate_or_reject(
                    "features",
                    tracked,
                    score,
                    reason,
                    frame,
                    state,
                    anchor_rect,
                    reject_reason,
                    reject_score,
                    interpolated,
                )
                if candidate:
                    candidates.append(candidate)

        best = select_tracking_candidate(candidates)
        if should_try_recovery(best, track, state):
            recovery = recover_track_candidates(track, state, frame, gray, anchor_gray, anchor_rect, frame_index)
            if recovery:
                candidates.extend(recovery)
                best = select_tracking_candidate(candidates)
        if best:
            return TrackingDecision(
                rect=best.rect,
                confidence=best.confidence,
                source=best.source,
                recovered=best.recovered or state.lost_count > 0,
            )

    if reject_reason:
        return TrackingDecision(rect=None, confidence=reject_score, reject_reason=reject_reason)

    return TrackingDecision(
        rect=interpolated or nearest_track_rect(track, frame_index),
        confidence=0.5 if interpolated else 0.35,
        source="fallback-interpolate" if interpolated else "fallback-nearest",
    )


def build_candidate_or_reject(
    source: str,
    rect: Rect | None,
    raw_score: float,
    reason: str | None,
    frame: np.ndarray,
    state: TrackState,
    anchor_rect: Rect,
    current_reject_reason: str | None,
    current_reject_score: float,
    expected_rect: Rect | None = None,
    recovered: bool = False,
) -> tuple[TrackingCandidate | None, str | None, float]:
    if rect is None:
        reject_reason, reject_score = remember_rejection(current_reject_reason, current_reject_score, reason, raw_score)
        return None, reject_reason, reject_score
    anchored, anchor_reason = validate_anchor_scale(rect, anchor_rect)
    if anchored is None:
        reject_reason, reject_score = remember_rejection(current_reject_reason, current_reject_score, anchor_reason, raw_score)
        return None, reject_reason, reject_score
    candidate = score_tracking_candidate(source, anchored, raw_score, frame, state, anchor_rect, expected_rect, recovered)
    return candidate, current_reject_reason, current_reject_score


def score_tracking_candidate(
    source: str,
    rect: Rect,
    raw_score: float,
    frame: np.ndarray,
    state: TrackState,
    anchor_rect: Rect,
    expected_rect: Rect | None = None,
    recovered: bool = False,
) -> TrackingCandidate:
    raw = clamp_float(raw_score, 0.0, 1.0)
    color = color_similarity_for_rect(frame, rect, state)
    motion = max(rect_iou(rect, state.rect), 1.0 - min(1.0, center_distance(rect, state.rect) / max(0.001, MAX_CENTER_SHIFT)))
    area = max(area_similarity_score(rect, state.rect), area_similarity_score(rect, anchor_rect) * 0.9)
    aspect = max(aspect_similarity_score(rect, state.rect), aspect_similarity_score(rect, anchor_rect) * 0.9)
    path = rect_iou(rect, expected_rect) if expected_rect is not None else 0.72
    source_bias = {
        "template": 0.04,
        "features": 0.03,
        "lk": 0.01,
        "tracker": -0.04,
        "recover-local": 0.0,
        "recover-anchor": -0.02,
        "recover-interpolate": 0.0,
    }.get(source, 0.0)
    confidence = 0.32 * raw + 0.22 * color + 0.15 * motion + 0.13 * area + 0.09 * aspect + 0.09 * path + source_bias
    if recovered:
        confidence -= 0.03
    return TrackingCandidate(
        rect=rect,
        confidence=clamp_float(confidence, 0.0, 1.0),
        source=source,
        raw_score=raw,
        color_similarity=color,
        path_similarity=path,
        recovered=recovered,
    )


def select_tracking_candidate(candidates: list[TrackingCandidate]) -> TrackingCandidate | None:
    if not candidates:
        return None
    for candidate in candidates:
        candidate.consensus = candidate_consensus(candidate, candidates)
        source_agreement = 1.0 if any(other.source != candidate.source and rect_iou(candidate.rect, other.rect) >= 0.45 for other in candidates) else 0.0
        consensus_boost = 0.07 * candidate.consensus + 0.03 * source_agreement
        isolated_penalty = 0.05 if len(candidates) > 1 and candidate.consensus < 0.18 and candidate.raw_score < 0.72 else 0.0
        candidate.confidence = clamp_float(candidate.confidence + consensus_boost - isolated_penalty, 0.0, 1.0)
    return max(candidates, key=lambda item: item.confidence)


def candidate_consensus(candidate: TrackingCandidate, candidates: list[TrackingCandidate]) -> float:
    peers = [other for other in candidates if other is not candidate]
    if not peers:
        return 0.0
    return max(rect_iou(candidate.rect, other.rect) for other in peers)


def should_try_recovery(candidate: TrackingCandidate | None, track: TrackSpec, state: TrackState) -> bool:
    if state.lost_count > 0:
        return True
    if candidate is None:
        return True
    return candidate.confidence < max(MIN_RECOVERY_SCORE, track.confidence_threshold * 0.9)


def recover_track_candidates(
    track: TrackSpec,
    state: TrackState,
    frame: np.ndarray,
    gray: np.ndarray,
    anchor_gray: np.ndarray,
    anchor_rect: Rect,
    frame_index: int,
) -> list[TrackingCandidate]:
    candidates: list[TrackingCandidate] = []
    search_rects = [state.rect, anchor_rect]
    interpolated = interpolate_rect(track, frame_index)
    if interpolated:
        search_rects.append(interpolated)
    seen = set()
    for index, search_rect in enumerate(search_rects):
        key = tuple(round(value, 4) for value in search_rect)
        if key in seen:
            continue
        seen.add(key)
        source = "recover-interpolate" if interpolated and search_rect == interpolated else "recover-anchor" if index == 1 else "recover-local"
        search_pad = 1.45 + min(1.2, state.lost_count * 0.22)
        rect, score, reason = track_with_template(
            anchor_gray,
            gray,
            anchor_rect,
            search_rect,
            search_pad=search_pad,
            scales=(0.72, 0.82, 0.92, 1.0, 1.1, 1.22, 1.36),
        )
        candidate, _, _ = build_candidate_or_reject(
            source,
            rect,
            score,
            reason,
            frame,
            state,
            anchor_rect,
            None,
            0.0,
            recovered=True,
        )
        if candidate and candidate.confidence >= MIN_RECOVERY_SCORE:
            candidates.append(candidate)
    return candidates


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


def track_with_features(previous: np.ndarray, current: np.ndarray, rect: Rect) -> tuple[Rect | None, float, str | None]:
    prev_crop, prev_offset = crop_from_rect(previous, rect, pad=0.15)
    search_crop, search_offset = crop_from_rect(current, rect, pad=0.55)
    if prev_crop.size == 0 or search_crop.size == 0:
        return None, 0.0, None

    detector, norm = create_feature_detector()
    kp1, des1 = detector.detectAndCompute(prev_crop, None)
    kp2, des2 = detector.detectAndCompute(search_crop, None)
    if des1 is None or des2 is None or len(kp1) < 6 or len(kp2) < 6:
        return None, 0.0, None

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
        return None, 0.0, None

    src = np.float32([kp1[match.queryIdx].pt for match in good]).reshape(-1, 1, 2)
    dst = np.float32([kp2[match.trainIdx].pt for match in good]).reshape(-1, 1, 2)
    matrix, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if matrix is None or inliers is None:
        return None, 0.0, None

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
    validated, reason = validate_tracked_rect(next_rect, rect)
    return validated, score if validated is not None else 0.0, reason


def track_with_lk(previous: np.ndarray, current: np.ndarray, rect: Rect) -> tuple[Rect | None, float, str | None]:
    x, y, w, h = rect_to_pixels(rect, previous.shape[1], previous.shape[0])
    mask = np.zeros_like(previous)
    mask[y : y + h, x : x + w] = 255
    points = cv2.goodFeaturesToTrack(previous, maxCorners=80, qualityLevel=0.01, minDistance=5, mask=mask)
    if points is None or len(points) < 4:
        return None, 0.0, None
    next_points, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None)
    if next_points is None or status is None:
        return None, 0.0, None
    back_points, back_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, next_points, None)
    if back_points is None or back_status is None:
        return None, 0.0, None
    fb_error = np.linalg.norm(points.reshape(-1, 2) - back_points.reshape(-1, 2), axis=1)
    valid = (status.reshape(-1) == 1) & (back_status.reshape(-1) == 1) & (fb_error <= 2.8)
    good_prev = points[valid]
    good_next = next_points[valid]
    if len(good_prev) < 4:
        return None, 0.0, None
    matrix, inliers = cv2.estimateAffinePartial2D(good_prev, good_next, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if matrix is None or inliers is None:
        return None, 0.0, None
    corners = np.float32([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]).reshape(-1, 1, 2)
    transformed = cv2.transform(corners, matrix).reshape(-1, 2)
    next_rect = pixels_to_rect(points_to_bbox(transformed), current.shape[1], current.shape[0])
    inlier_ratio = float(np.count_nonzero(inliers)) / max(1, len(good_prev))
    fb_score = 1.0 - min(1.0, float(np.median(fb_error[valid])) / 2.8)
    score = inlier_ratio * (0.72 + 0.28 * fb_score)
    validated, reason = validate_tracked_rect(next_rect, rect)
    return validated, score if validated is not None else 0.0, reason


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


def track_with_cv_tracker(tracker: Any | None, current: np.ndarray, previous_rect: Rect) -> tuple[Rect | None, float, str | None]:
    if tracker is None:
        return None, 0.0, None
    try:
        ok, bbox = tracker.update(current)
    except cv2.error:
        return None, 0.0, None
    if not ok:
        return None, 0.0, None
    x, y, w, h = bbox
    candidate = pixels_to_rect((int(round(x)), int(round(y)), int(round(w)), int(round(h))), current.shape[1], current.shape[0])
    validated, reason = validate_tracked_rect(candidate, previous_rect)
    return validated, 0.76 if validated is not None else 0.0, reason


def track_with_template(
    template_frame: np.ndarray,
    current: np.ndarray,
    template_rect: Rect,
    search_rect: Rect | None = None,
    search_pad: float = 0.9,
    scales: tuple[float, ...] = (0.94, 1.0, 1.06),
) -> tuple[Rect | None, float, str | None]:
    search_rect = search_rect or template_rect
    template_crop, template_offset = crop_from_rect(template_frame, template_rect, pad=0.08)
    search_crop, search_offset = crop_from_rect(current, search_rect, pad=search_pad)
    if template_crop.size == 0 or search_crop.size == 0:
        return None, 0.0, None
    if template_crop.shape[0] < 10 or template_crop.shape[1] < 10:
        return None, 0.0, None
    if search_crop.shape[0] < template_crop.shape[0] or search_crop.shape[1] < template_crop.shape[1]:
        return None, 0.0, None

    template_signal = matching_signal(template_crop)
    search_signal = matching_signal(search_crop)
    if float(np.std(template_signal)) < 4.0:
        return None, 0.0, None

    work_scale = min(1.0, 420.0 / max(search_signal.shape[:2]))
    if work_scale < 1.0:
        template_signal = resize_for_matching(template_signal, work_scale)
        search_signal = resize_for_matching(search_signal, work_scale)

    x, y, w, h = rect_to_pixels(template_rect, template_frame.shape[1], template_frame.shape[0])
    best_rect: Rect | None = None
    best_score = 0.0
    best_reject_reason = None
    best_reject_score = 0.0
    rect_offset_x = x - template_offset[0]
    rect_offset_y = y - template_offset[1]
    for scale in scales:
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
        candidate, reject_reason = validate_tracked_rect(pixels_to_rect(candidate_pixels, current.shape[1], current.shape[0]), search_rect)
        if candidate is not None and max_value > best_score:
            best_rect = candidate
            best_score = float(max_value)
        elif reject_reason and max_value > best_reject_score:
            best_reject_reason = reject_reason
            best_reject_score = float(max_value)

    return best_rect, best_score, None if best_rect is not None else best_reject_reason


def matching_signal(gray: np.ndarray) -> np.ndarray:
    enhanced = enhance_gray(gray)
    edges = cv2.Canny(enhanced, 50, 150)
    edge_density = float(np.count_nonzero(edges)) / max(1, edges.size)
    if edge_density > 0.015:
        return edges
    return enhanced


def enhance_gray(gray: np.ndarray) -> np.ndarray:
    if gray.size == 0:
        return gray
    if min(gray.shape[:2]) >= 16:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        return clahe.apply(gray)
    return cv2.equalizeHist(gray)


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


def validate_tracked_rect(candidate: Rect | None, previous: Rect) -> tuple[Rect | None, str | None]:
    if candidate is None:
        return None, None
    _, _, pw, ph = previous
    x, y, w, h = candidate
    if w <= 0.004 or h <= 0.004:
        return None, "追踪框过小"
    if center_distance(candidate, previous) > MAX_CENTER_SHIFT:
        return None, "追踪跳变过大"
    aspect_reason = aspect_ratio_reason(candidate, previous)
    if aspect_reason:
        return None, aspect_reason
    area_ratio = (w * h) / max(0.000001, pw * ph)
    if area_ratio < MIN_TRACKED_AREA_RATIO:
        return None, "追踪尺度缩小过多"
    if area_ratio > MAX_TRACKED_AREA_RATIO:
        return None, "追踪尺度放大过多"
    return clamp_rect((x, y, w, h)), None


def validate_anchor_scale(candidate: Rect, anchor: Rect | None) -> tuple[Rect | None, str | None]:
    if anchor is None:
        return candidate, None
    aspect_reason = aspect_ratio_reason(candidate, anchor)
    if aspect_reason:
        return None, aspect_reason
    area_ratio = rect_area(candidate) / max(0.000001, rect_area(anchor))
    if area_ratio < MIN_ANCHOR_AREA_RATIO:
        return None, "追踪尺度小于人工关键帧范围"
    if area_ratio > MAX_ANCHOR_AREA_RATIO:
        return None, "追踪尺度超出人工关键帧范围"
    return candidate, None


def stabilize_rect(candidate: Rect, previous: Rect, confidence: float | None, scale_mode: str = "locked", anchor: Rect | None = None) -> Rect:
    _, _, pw, ph = previous
    _, _, cw, ch = candidate
    p_center_x, p_center_y = rect_center(previous)
    c_center_x, c_center_y = rect_center(candidate)
    confidence_value = clamp_float(confidence if confidence is not None else 0.5, 0.0, 1.0)
    if scale_mode == "locked":
        size_reference = anchor or previous
        _, _, smooth_w, smooth_h = size_reference
    else:
        if scale_mode == "slow-zoom":
            max_step = 0.025 + 0.025 * confidence_value
            size_smoothing = 0.9 - 0.16 * confidence_value
        else:
            max_step = MAX_FRAME_SCALE_STEP + 0.05 * confidence_value
            size_smoothing = SIZE_SMOOTHING - 0.22 * confidence_value
        limited_w = limit_ratio(cw, pw, max_step)
        limited_h = limit_ratio(ch, ph, max_step)
        smooth_w = pw * size_smoothing + limited_w * (1.0 - size_smoothing)
        smooth_h = ph * size_smoothing + limited_h * (1.0 - size_smoothing)
    center_smoothing = CENTER_SMOOTHING - 0.18 * confidence_value
    smooth_center_x = p_center_x * center_smoothing + c_center_x * (1.0 - center_smoothing)
    smooth_center_y = p_center_y * center_smoothing + c_center_y * (1.0 - center_smoothing)
    return clamp_rect((smooth_center_x - smooth_w / 2, smooth_center_y - smooth_h / 2, smooth_w, smooth_h))


def limit_ratio(value: float, reference: float, max_step: float) -> float:
    if reference <= 0:
        return value
    lower = reference * (1.0 - max_step)
    upper = reference * (1.0 + max_step)
    return clamp_float(value, lower, upper)


def aspect_ratio_reason(candidate: Rect, reference: Rect) -> str | None:
    _, _, cw, ch = candidate
    _, _, rw, rh = reference
    candidate_ratio = cw / max(0.000001, ch)
    reference_ratio = rw / max(0.000001, rh)
    ratio_change = candidate_ratio / max(0.000001, reference_ratio)
    if ratio_change > MAX_ASPECT_RATIO_CHANGE or ratio_change < 1.0 / MAX_ASPECT_RATIO_CHANGE:
        return "追踪框宽高比例变化过大"
    return None


def center_distance(candidate: Rect, reference: Rect) -> float:
    cx, cy = rect_center(candidate)
    rx, ry = rect_center(reference)
    return math.hypot(cx - rx, cy - ry)


def rect_center(rect: Rect) -> tuple[float, float]:
    x, y, w, h = rect
    return x + w / 2, y + h / 2


def rect_area(rect: Rect) -> float:
    _, _, w, h = rect
    return max(0.0, w * h)


def remember_rejection(current_reason: str | None, current_score: float, reason: str | None, score: float) -> tuple[str | None, float]:
    if reason and score >= current_score:
        return reason, score
    return current_reason, current_score


def mark_track_lost(states: dict[str, TrackState], track: TrackSpec, state: TrackState | None) -> None:
    if state is None:
        return
    states[track.id] = TrackState(
        rect=state.rect,
        previous_gray=state.previous_gray,
        anchor_gray=state.anchor_gray,
        anchor_rect=state.anchor_rect,
        previous_hist=state.previous_hist,
        anchor_hist=state.anchor_hist,
        tracker=state.tracker,
        lost_count=state.lost_count + 1,
        last_source=state.last_source,
    )


def is_scale_rejection(reason: str) -> bool:
    return any(token in reason for token in ("尺度", "宽高", "跳变", "过小", "放大", "缩小"))


def rect_iou(left: Rect, right: Rect) -> float:
    lx, ly, lw, lh = left
    rx, ry, rw, rh = right
    ix1 = max(lx, rx)
    iy1 = max(ly, ry)
    ix2 = min(lx + lw, rx + rw)
    iy2 = min(ly + lh, ry + rh)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = rect_area(left) + rect_area(right) - inter
    if union <= 0:
        return 0.0
    return inter / union


def area_similarity_score(candidate: Rect, reference: Rect) -> float:
    ratio = rect_area(candidate) / max(0.000001, rect_area(reference))
    if ratio <= 0:
        return 0.0
    return clamp_float(1.0 - abs(math.log(ratio)) / math.log(MAX_TRACKED_AREA_RATIO), 0.0, 1.0)


def aspect_similarity_score(candidate: Rect, reference: Rect) -> float:
    _, _, cw, ch = candidate
    _, _, rw, rh = reference
    ratio = (cw / max(0.000001, ch)) / max(0.000001, rw / max(0.000001, rh))
    if ratio <= 0:
        return 0.0
    return clamp_float(1.0 - abs(math.log(ratio)) / math.log(MAX_ASPECT_RATIO_CHANGE), 0.0, 1.0)


def color_similarity_for_rect(frame: np.ndarray, rect: Rect, state: TrackState) -> float:
    hist = color_hist(frame, rect)
    similarities = []
    if state.previous_hist is not None:
        similarities.append(compare_hist(hist, state.previous_hist))
    if state.anchor_hist is not None:
        similarities.append(compare_hist(hist, state.anchor_hist))
    return max(similarities) if similarities else 0.72


def color_hist(frame: np.ndarray, rect: Rect) -> np.ndarray:
    x, y, w, h = rect_to_pixels(rect, frame.shape[1], frame.shape[0])
    crop = frame[y : y + h, x : x + w]
    if crop.size == 0:
        return np.zeros((256, 1), dtype=np.float32)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [24, 24], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
    return hist.astype(np.float32)


def compare_hist(left: np.ndarray, right: np.ndarray) -> float:
    if left.size == 0 or right.size == 0:
        return 0.0
    score = float(cv2.compareHist(left, right, cv2.HISTCMP_CORREL))
    return clamp_float((score + 1.0) / 2.0, 0.0, 1.0)


def apply_mask(
    frame: np.ndarray,
    rect: Rect,
    effect: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
    solid_alpha: float = 1.0,
) -> None:
    x, y, w, h = rect_to_pixels(rect, frame.shape[1], frame.shape[0])
    if w <= 0 or h <= 0:
        return
    roi = frame[y : y + h, x : x + w]
    if effect == "solid":
        alpha = clamp_float(solid_alpha, 0.0, 1.0)
        solid = np.full_like(roi, solid_color)
        masked = solid if alpha >= 1.0 else cv2.addWeighted(roi, 1.0 - alpha, solid, alpha, 0)
    elif effect == "blur":
        kernel = max(3, blur_size | 1)
        masked = cv2.GaussianBlur(roi, (kernel, kernel), 0)
    else:
        masked = mosaic(roi, block_size)
    frame[y : y + h, x : x + w] = masked


def apply_track_mask(
    frame: np.ndarray,
    rect: Rect,
    track: TrackSpec,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
) -> None:
    strength = normalize_mask_strength(track.strength)
    apply_mask(
        frame,
        rect,
        track.effect,
        block_size_for_strength(block_size, strength),
        blur_size_for_strength(blur_size, strength),
        solid_color,
        solid_alpha_for_strength(strength),
    )


def block_size_for_strength(max_block_size: int, strength: float) -> int:
    maximum = max(2, int(max_block_size))
    minimum = min(maximum, 6)
    return max(2, int(round(minimum + (maximum - minimum) * normalize_mask_strength(strength))))


def blur_size_for_strength(max_blur_size: int, strength: float) -> int:
    maximum = max(3, int(max_blur_size) | 1)
    minimum = min(maximum, 9)
    kernel = int(round(minimum + (maximum - minimum) * normalize_mask_strength(strength)))
    return max(3, kernel | 1)


def solid_alpha_for_strength(strength: float) -> float:
    return normalize_mask_strength(strength)


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


def clamp_float(value: float, minimum: float, maximum: float) -> float:
    if math.isnan(value) or math.isinf(value):
        return minimum
    return min(maximum, max(minimum, value))


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
