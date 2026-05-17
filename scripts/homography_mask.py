#!/usr/bin/env python3
"""SIFT/AKAZE/ORB + RANSAC homography mask tracker for Videogen."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from brand_mask import (
    FrameIssue,
    Rect,
    TrackSpec,
    apply_track_mask,
    center_distance,
    cleanup_temp,
    compact_issues,
    compare_hist,
    crop_from_rect,
    exact_keyframe,
    expand_rect,
    interpolate_rect,
    is_scale_rejection,
    issue_to_dict,
    merge_audio,
    nearest_track_rect,
    parse_solid_color,
    parse_tracks,
    pixels_to_rect,
    points_to_bbox,
    rect_iou,
    rect_to_pixels,
    stabilize_rect,
    validate_anchor_scale,
    validate_tracked_rect,
    color_hist,
    enhance_gray,
)


MIN_GOOD_MATCHES = 8
MIN_INLIERS = 6
MAX_REPROJECTION_ERROR = 5.5


@dataclass
class HomographyState:
    rect: Rect
    previous_gray: np.ndarray
    anchor_gray: np.ndarray
    anchor_rect: Rect
    previous_hist: np.ndarray
    anchor_hist: np.ndarray
    lost_count: int = 0


@dataclass
class HomographyCandidate:
    rect: Rect
    confidence: float
    source: str
    raw_score: float
    recovered: bool = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply user-guided masks with feature homography tracking.")
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
        raise SystemExit(f"Homography mask has {result['blockedFrames']} red frames; add correction keyframes.")
    return 0


def process_video(input_path: Path, output_path: Path, spec_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {input_path}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    source_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if width <= 0 or height <= 0:
        raise SystemExit("Input video has invalid dimensions.")

    spec = json.loads(spec_path.read_text("utf8"))
    tracks = parse_tracks(spec, fps)
    if not tracks:
        raise SystemExit("Mask spec has no usable tracks.")

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_homography_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    states: dict[str, HomographyState] = {}
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
                rect, confidence, reject_reason, source, recovered = resolve_homography_rect(
                    track,
                    previous_state,
                    frame,
                    gray,
                    processed_frames,
                    frame_time,
                )
                exact = exact_keyframe(track, processed_frames, frame_time)
                if reject_reason:
                    skipped_tracking_frames.add(processed_frames)
                    if is_scale_rejection(reject_reason):
                        skipped_scale_frames.add(processed_frames)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity="error",
                            reason=f"{track.label} {reject_reason}，已跳过该帧。",
                            confidence=round(confidence, 3) if confidence is not None else None,
                        )
                    )
                    mark_track_lost(states, track, previous_state)
                    continue
                if rect is None:
                    mark_track_lost(states, track, previous_state)
                    continue
                if confidence is not None and confidence < track.confidence_threshold:
                    skipped_low_confidence_frames.add(processed_frames)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity="error",
                            reason=f"{track.label} Homography 置信度不足，已跳过该帧。",
                            confidence=round(confidence, 3),
                        )
                    )
                    if not exact:
                        mark_track_lost(states, track, previous_state)
                        continue
                if previous_state and not exact and source == "homography":
                    rect = stabilize_rect(rect, previous_state.rect, confidence, track.scale_mode, previous_state.anchor_rect)
                apply_track_mask(output, expand_rect(rect, track.expand_ratio), track, args.block, args.blur, solid_color)
                if recovered:
                    recovered_frames.add(processed_frames)
                states[track.id] = build_state(track, previous_state, gray, frame, rect, exact is not None or previous_state is None)
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
        "sourceFrameCount": source_frame_count,
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


def resolve_homography_rect(
    track: TrackSpec,
    state: HomographyState | None,
    frame: np.ndarray,
    gray: np.ndarray,
    frame_index: int,
    frame_time: float,
) -> tuple[Rect | None, float | None, str | None, str, bool]:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return exact.rect, 1.0, None, "manual", False
    if track.track_mode == "manual":
        return None, None, None, "manual", False
    if track.track_mode == "static":
        return nearest_track_rect(track, frame_index), 1.0, None, "static", False
    interpolated = interpolate_rect(track, frame_index)
    if track.track_mode == "interpolate":
        return interpolated or nearest_track_rect(track, frame_index), 0.9, None, "interpolate", False
    if state is None:
        return None, 0.0, "Homography 尚未获得人工关键帧", "homography", False

    candidates: list[HomographyCandidate] = []
    reject_reason = "Homography 特征点不足"
    reject_score = 0.0
    for candidate, reason, score in (
        attempt_homography(
            state.previous_gray,
            gray,
            state.rect,
            state.rect,
            state,
            frame,
            "homography",
            search_pad=0.78 + min(0.5, state.lost_count * 0.12),
            recovered=state.lost_count > 0,
        ),
        attempt_homography(
            state.anchor_gray,
            gray,
            state.anchor_rect,
            interpolated or state.rect,
            state,
            frame,
            "homography-recover",
            search_pad=1.15 + min(0.75, state.lost_count * 0.18),
            recovered=True,
        ),
    ):
        if candidate:
            candidates.append(candidate)
        elif reason and score >= reject_score:
            reject_reason = reason
            reject_score = score

    if candidates:
        best = max(candidates, key=lambda item: item.confidence)
        return best.rect, best.confidence, None, "homography", best.recovered
    return None, reject_score, reject_reason, "homography", False


def attempt_homography(
    template_gray: np.ndarray,
    current_gray: np.ndarray,
    template_rect: Rect,
    search_rect: Rect,
    state: HomographyState,
    frame: np.ndarray,
    source: str,
    search_pad: float,
    recovered: bool,
) -> tuple[HomographyCandidate | None, str | None, float]:
    rect, raw_score, reason = track_with_homography(template_gray, current_gray, template_rect, search_rect, search_pad)
    if rect is None:
        return None, reason, raw_score
    validated, validate_reason = validate_tracked_rect(rect, search_rect)
    if validated is None:
        return None, validate_reason or "Homography 追踪框异常", raw_score
    anchored, anchor_reason = validate_anchor_scale(validated, state.anchor_rect)
    if anchored is None:
        return None, anchor_reason or "Homography 尺度异常", raw_score
    color_score = max(
        compare_hist(color_hist(frame, anchored), state.previous_hist),
        compare_hist(color_hist(frame, anchored), state.anchor_hist),
    )
    motion_score = max(rect_iou(anchored, state.rect), 1.0 - min(1.0, center_distance(anchored, state.rect) / 0.24))
    confidence = 0.66 * raw_score + 0.2 * color_score + 0.14 * motion_score
    if recovered:
        confidence -= 0.04
    return HomographyCandidate(anchored, max(0.0, min(1.0, confidence)), source, raw_score, recovered), None, raw_score


def track_with_homography(
    template_gray: np.ndarray,
    current_gray: np.ndarray,
    template_rect: Rect,
    search_rect: Rect,
    search_pad: float,
) -> tuple[Rect | None, float, str | None]:
    template_crop, template_offset = crop_from_rect(template_gray, template_rect, pad=0.18)
    search_crop, search_offset = crop_from_rect(current_gray, search_rect, pad=search_pad)
    if min(template_crop.shape[:2] or (0, 0)) < 10 or min(search_crop.shape[:2] or (0, 0)) < 10:
        return None, 0.0, "Homography 目标区域过小"

    template_work = enhance_gray(template_crop)
    search_work = enhance_gray(search_crop)
    best: tuple[Rect | None, float, str | None] = (None, 0.0, "Homography 特征点不足")
    for detector_name, detector, norm, ratio in create_feature_detectors():
        kp1, des1 = detector.detectAndCompute(template_work, None)
        kp2, des2 = detector.detectAndCompute(search_work, None)
        if des1 is None or des2 is None or len(kp1) < MIN_GOOD_MATCHES or len(kp2) < MIN_GOOD_MATCHES:
            continue
        matcher = cv2.BFMatcher(norm)
        try:
            matches = matcher.knnMatch(des1, des2, k=2)
        except cv2.error:
            continue
        good = []
        for pair in matches:
            if len(pair) < 2:
                continue
            first, second = pair
            if first.distance < ratio * second.distance:
                good.append(first)
        if len(good) < MIN_GOOD_MATCHES:
            best = better_reject(best, None, len(good) / MIN_GOOD_MATCHES * 0.35, f"{detector_name} 匹配点不足")
            continue

        src = np.float32([kp1[match.queryIdx].pt for match in good]).reshape(-1, 1, 2)
        dst = np.float32([kp2[match.trainIdx].pt for match in good]).reshape(-1, 1, 2)
        matrix, inliers = cv2.findHomography(src, dst, cv2.RANSAC, MAX_REPROJECTION_ERROR)
        if matrix is None or inliers is None or not np.all(np.isfinite(matrix)):
            best = better_reject(best, None, 0.38, f"{detector_name} 单应矩阵不稳定")
            continue
        inlier_mask = inliers.reshape(-1).astype(bool)
        inlier_count = int(np.count_nonzero(inlier_mask))
        if inlier_count < MIN_INLIERS:
            best = better_reject(best, None, inlier_count / MIN_INLIERS * 0.45, f"{detector_name} RANSAC 内点不足")
            continue

        x, y, w, h = rect_to_pixels(template_rect, template_gray.shape[1], template_gray.shape[0])
        local_corners = np.float32(
            [
                [x - template_offset[0], y - template_offset[1]],
                [x + w - template_offset[0], y - template_offset[1]],
                [x + w - template_offset[0], y + h - template_offset[1]],
                [x - template_offset[0], y + h - template_offset[1]],
            ]
        ).reshape(-1, 1, 2)
        transformed = cv2.perspectiveTransform(local_corners, matrix).reshape(-1, 2)
        if not np.all(np.isfinite(transformed)):
            best = better_reject(best, None, 0.38, f"{detector_name} 透视变换不稳定")
            continue
        transformed[:, 0] += search_offset[0]
        transformed[:, 1] += search_offset[1]
        candidate = pixels_to_rect(points_to_bbox(transformed), current_gray.shape[1], current_gray.shape[0])

        projected = cv2.perspectiveTransform(src, matrix).reshape(-1, 2)
        errors = np.linalg.norm(projected - dst.reshape(-1, 2), axis=1)
        inlier_errors = errors[inlier_mask]
        median_error = float(np.median(inlier_errors)) if len(inlier_errors) else MAX_REPROJECTION_ERROR
        inlier_ratio = inlier_count / max(1, len(good))
        match_score = min(1.0, len(good) / 24.0)
        geometry_score = 1.0 - min(1.0, median_error / MAX_REPROJECTION_ERROR)
        score = 0.48 * inlier_ratio + 0.3 * match_score + 0.22 * geometry_score
        best = better_reject(best, candidate, score, None)
    return best


def create_feature_detectors() -> list[tuple[str, Any, int, float]]:
    detectors: list[tuple[str, Any, int, float]] = []
    if hasattr(cv2, "SIFT_create"):
        detectors.append(("SIFT", cv2.SIFT_create(nfeatures=700, contrastThreshold=0.018), cv2.NORM_L2, 0.72))
    if hasattr(cv2, "AKAZE_create"):
        detectors.append(("AKAZE", cv2.AKAZE_create(), cv2.NORM_HAMMING, 0.76))
    detectors.append(("ORB", cv2.ORB_create(nfeatures=900, scaleFactor=1.16, nlevels=8, edgeThreshold=8), cv2.NORM_HAMMING, 0.78))
    return detectors


def better_reject(
    current: tuple[Rect | None, float, str | None],
    candidate: Rect | None,
    score: float,
    reason: str | None,
) -> tuple[Rect | None, float, str | None]:
    if candidate is not None:
        if current[0] is None or score > current[1]:
            return candidate, score, None
        return current
    if current[0] is None and score > current[1]:
        return None, score, reason
    return current


def build_state(
    track: TrackSpec,
    previous: HomographyState | None,
    gray: np.ndarray,
    frame: np.ndarray,
    rect: Rect,
    reset_anchor: bool,
) -> HomographyState:
    hist = color_hist(frame, rect)
    return HomographyState(
        rect=rect,
        previous_gray=gray,
        anchor_gray=gray if reset_anchor or previous is None else previous.anchor_gray,
        anchor_rect=rect if reset_anchor or previous is None else previous.anchor_rect,
        previous_hist=hist,
        anchor_hist=hist if reset_anchor or previous is None else previous.anchor_hist,
        lost_count=0,
    )


def mark_track_lost(states: dict[str, HomographyState], track: TrackSpec, state: HomographyState | None) -> None:
    if state is None:
        return
    states[track.id] = HomographyState(
        rect=state.rect,
        previous_gray=state.previous_gray,
        anchor_gray=state.anchor_gray,
        anchor_rect=state.anchor_rect,
        previous_hist=state.previous_hist,
        anchor_hist=state.anchor_hist,
        lost_count=state.lost_count + 1,
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
