#!/usr/bin/env python3
"""Qualcomm Track-Anything masking adapter for Videogen object-mask comparison.

This adapter uses a user rectangle as the initial object mask. It intentionally
skips frames when Track-Anything produces empty, jumping, or oversized masks.
"""

from __future__ import annotations

import argparse
import json
import shutil
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
    block_size_for_strength,
    blur_size_for_strength,
    cleanup_temp,
    compact_issues,
    exact_keyframe,
    expand_rect,
    issue_to_dict,
    merge_audio,
    parse_solid_color,
    parse_tracks,
    rect_to_pixels,
    stabilize_rect,
    solid_alpha_for_strength,
    validate_anchor_scale,
    validate_tracked_rect,
)


@dataclass
class MaskFrame:
    frame_index: int
    mask: np.ndarray
    rect: Rect


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply user-guided masks with Qualcomm Track-Anything.")
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
        raise SystemExit(f"Track-Anything mask has {result['blockedFrames']} red frames; add correction keyframes.")
    return 0


def load_track_anything() -> tuple[Any, Any]:
    try:
        from qai_hub_models.models.track_anything.app import TrackAnythingApp
        from qai_hub_models.models.track_anything.model import TrackAnythingWrapper
    except ModuleNotFoundError as error:
        raise SystemExit(
            "Track-Anything Python dependencies are not installed. "
            "Install with: .venv-face-mosaic/bin/python -m pip install 'qai-hub-models[track-anything]'"
        ) from error

    wrapper = TrackAnythingWrapper.from_pretrained()
    enc_shape = wrapper.EncodeValue.get_input_spec()["image"][0]
    input_shape = (enc_shape[-2], enc_shape[-1])
    return TrackAnythingApp, (wrapper, input_shape)


def process_video(input_path: Path, output_path: Path, spec_path: Path, args: argparse.Namespace) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise SystemExit(f"Could not open video: {input_path}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    source_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frames_bgr: list[np.ndarray] = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames_bgr.append(frame)
    capture.release()
    if not frames_bgr:
        raise SystemExit("Input video has no frames.")

    spec = json.loads(spec_path.read_text("utf8"))
    tracks = parse_tracks(spec, fps)
    if not tracks:
        raise SystemExit("Mask spec has no usable tracks.")

    track_app_cls, (wrapper, input_shape) = load_track_anything()
    solid_color = parse_solid_color(args.solid_color)
    started_at = time.time()
    issues: list[FrameIssue] = []
    skipped_low_confidence_frames: set[int] = set()
    skipped_scale_frames: set[int] = set()
    skipped_tracking_frames: set[int] = set()
    masked_frame_indexes: set[int] = set()

    masks_by_track = build_masks_by_track(
        tracks,
        frames_bgr,
        track_app_cls,
        wrapper,
        input_shape,
        fps,
        issues,
        skipped_scale_frames,
        skipped_tracking_frames,
    )

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_track_anything_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        raise SystemExit("Could not create temporary video writer.")

    try:
        for frame_index, frame in enumerate(frames_bgr):
            output = frame.copy()
            for track in tracks:
                mask_frame = masks_by_track.get(track.id, {}).get(frame_index)
                if mask_frame is None:
                    continue
                if mask_frame.mask.size == 0 or not np.any(mask_frame.mask):
                    skipped_tracking_frames.add(frame_index)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=frame_index,
                            time=round(frame_index / fps, 3),
                            severity="error",
                            reason=f"{track.label} Track-Anything 输出空遮罩，已跳过该帧。",
                            confidence=None,
                        )
                    )
                    continue
                apply_mask_to_binary(output, mask_frame.mask, track.effect, args.block, args.blur, solid_color, track.expand_ratio, track.strength)
                masked_frame_indexes.add(frame_index)
            writer.write(output)
    finally:
        writer.release()

    merge_audio(input_path, temp_video, output_path, args.crf)
    cleanup_temp(temp_dir, args.keep_temp)

    error_frames = sorted({issue.frame_index for issue in issues if issue.severity == "error"})
    warning_frames = sorted({issue.frame_index for issue in issues if issue.severity == "warning"})
    return {
        "frameCount": len(frames_bgr),
        "sourceFrameCount": source_frame_count,
        "maskedFrames": len(masked_frame_indexes),
        "skippedLowConfidenceFrames": len(skipped_low_confidence_frames),
        "skippedScaleFrames": len(skipped_scale_frames),
        "skippedTrackingFrames": len(skipped_tracking_frames),
        "recoveredFrames": 0,
        "trackCount": len(tracks),
        "manualKeyframes": sum(1 for track in tracks for keyframe in track.keyframes if keyframe.source == "manual"),
        "correctedKeyframes": sum(1 for track in tracks for keyframe in track.keyframes if keyframe.source == "correction"),
        "warningFrames": len(warning_frames),
        "blockedFrames": len(error_frames),
        "width": width,
        "height": height,
        "fps": fps,
        "durationSec": round(len(frames_bgr) / fps, 3) if fps else None,
        "elapsedSec": round(time.time() - started_at, 3),
        "output": str(output_path),
        "issues": [issue_to_dict(issue) for issue in compact_issues(issues)],
    }


def build_masks_by_track(
    tracks: list[TrackSpec],
    frames_bgr: list[np.ndarray],
    track_app_cls: Any,
    wrapper: Any,
    input_shape: tuple[int, int],
    fps: float,
    issues: list[FrameIssue],
    skipped_scale_frames: set[int],
    skipped_tracking_frames: set[int],
) -> dict[str, dict[int, MaskFrame]]:
    result: dict[str, dict[int, MaskFrame]] = {}
    for track in tracks:
        result[track.id] = {}
        keyframes = sorted(track.keyframes, key=lambda item: item.frame_index)
        for index, keyframe in enumerate(keyframes):
            start = max(0, min(len(frames_bgr) - 1, keyframe.frame_index))
            next_keyframe = keyframes[index + 1] if index + 1 < len(keyframes) else None
            end = max(start + 1, min(len(frames_bgr), next_keyframe.frame_index + 1 if next_keyframe else len(frames_bgr)))
            segment_frames = frames_bgr[start:end]
            if not segment_frames:
                continue
            raw_masks = track_span(track_app_cls, wrapper, input_shape, segment_frames, keyframe.rect)
            previous_rect = keyframe.rect
            anchor_rect = keyframe.rect
            for offset, raw_mask in enumerate(raw_masks[: len(segment_frames)]):
                frame_index = start + offset
                exact = exact_keyframe(track, frame_index, frame_index / fps if fps else 0.0)
                candidate_rect = mask_to_rect(raw_mask)
                if candidate_rect is None:
                    skipped_tracking_frames.add(frame_index)
                    issues.append(
                        FrameIssue(track.id, frame_index, round(frame_index / fps, 3), "error", f"{track.label} Track-Anything 输出空遮罩，已跳过该帧。")
                    )
                    continue
                if not exact:
                    validated, reason = validate_tracked_rect(candidate_rect, previous_rect)
                    if validated is None:
                        skipped_tracking_frames.add(frame_index)
                        skipped_scale_frames.add(frame_index)
                        issues.append(
                            FrameIssue(track.id, frame_index, round(frame_index / fps, 3), "error", f"{track.label} {reason or 'Track-Anything 框异常'}，已跳过该帧。")
                        )
                        continue
                    anchored, anchor_reason = validate_anchor_scale(validated, anchor_rect)
                    if anchored is None:
                        skipped_tracking_frames.add(frame_index)
                        skipped_scale_frames.add(frame_index)
                        issues.append(
                            FrameIssue(track.id, frame_index, round(frame_index / fps, 3), "error", f"{track.label} {anchor_reason or 'Track-Anything 尺度异常'}，已跳过该帧。")
                        )
                        continue
                    candidate_rect = stabilize_rect(anchored, previous_rect, 0.72, track.scale_mode, anchor_rect)
                result[track.id][frame_index] = MaskFrame(frame_index=frame_index, mask=raw_mask.astype(np.uint8), rect=candidate_rect)
                previous_rect = candidate_rect
    return result


def track_span(track_app_cls: Any, wrapper: Any, input_shape: tuple[int, int], frames_bgr: list[np.ndarray], rect: Rect) -> list[np.ndarray]:
    frames_rgb = [cv2.cvtColor(frame, cv2.COLOR_BGR2RGB) for frame in frames_bgr]
    initial_mask = rect_to_mask(rect, frames_bgr[0].shape[1], frames_bgr[0].shape[0])
    padded_frames = pad_frames_for_track_anything(frames_rgb)
    app = track_app_cls(
        wrapper.EncodeKeyWithShrinkage,
        wrapper.EncodeValue,
        wrapper.EncodeKeyWithoutShrinkage,
        wrapper.Segment,
        dict(wrapper.config),
    )
    raw_masks = app.track(padded_frames, initial_mask, raw_output=True)
    return dedupe_track_anything_masks(raw_masks, len(frames_bgr))


def pad_frames_for_track_anything(frames: list[np.ndarray]) -> list[np.ndarray]:
    if not frames:
        return frames
    target = max(5, len(frames))
    last_start = ((target - 1) // 4) * 4
    target = max(target, last_start + 5)
    padded = list(frames)
    while len(padded) < target:
        padded.append(frames[-1])
    return padded


def dedupe_track_anything_masks(raw_masks: list[np.ndarray], target_length: int) -> list[np.ndarray]:
    if not raw_masks:
        return []
    result: list[np.ndarray] = []
    for start in range(0, len(raw_masks), 5):
        chunk = raw_masks[start : start + 5]
        if start == 0:
            result.extend(chunk)
        else:
            result.extend(chunk[1:])
        if len(result) >= target_length:
            break
    return result[:target_length]


def rect_to_mask(rect: Rect, width: int, height: int) -> np.ndarray:
    mask = np.zeros((height, width), dtype=np.uint8)
    x, y, w, h = rect_to_pixels(rect, width, height)
    mask[y : y + h, x : x + w] = 1
    return mask


def mask_to_rect(mask: np.ndarray) -> Rect | None:
    if mask.size == 0:
        return None
    y_points, x_points = np.where(mask > 0)
    if len(x_points) == 0 or len(y_points) == 0:
        return None
    x1 = int(np.min(x_points))
    x2 = int(np.max(x_points)) + 1
    y1 = int(np.min(y_points))
    y2 = int(np.max(y_points)) + 1
    return x1 / mask.shape[1], y1 / mask.shape[0], (x2 - x1) / mask.shape[1], (y2 - y1) / mask.shape[0]


def apply_mask_to_binary(
    frame: np.ndarray,
    mask: np.ndarray,
    effect: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
    expand_ratio: float,
    strength: float = 0.85,
) -> None:
    binary = expand_binary_mask(mask, expand_ratio)
    if not np.any(binary):
        return
    block_size = block_size_for_strength(block_size, strength)
    blur_size = blur_size_for_strength(blur_size, strength)
    solid_alpha = solid_alpha_for_strength(strength)
    if effect == "solid":
        solid = np.full_like(frame, solid_color)
        masked = solid if solid_alpha >= 1.0 else cv2.addWeighted(frame, 1.0 - solid_alpha, solid, solid_alpha, 0)
    elif effect == "blur":
        kernel = max(3, blur_size | 1)
        masked = cv2.GaussianBlur(frame, (kernel, kernel), 0)
    else:
        masked = mosaic_frame(frame, binary, block_size)
    frame[binary > 0] = masked[binary > 0]


def expand_binary_mask(mask: np.ndarray, expand_ratio: float) -> np.ndarray:
    if expand_ratio <= 0 or not np.any(mask):
        return (mask > 0).astype(np.uint8)
    rect = mask_to_rect(mask)
    if rect is None:
        return (mask > 0).astype(np.uint8)
    expanded = expand_rect(rect, expand_ratio)
    x, y, w, h = rect_to_pixels(expanded, mask.shape[1], mask.shape[0])
    kernel_size = max(3, int(round(max(w, h) * expand_ratio)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size | 1, kernel_size | 1))
    return cv2.dilate((mask > 0).astype(np.uint8), kernel)


def mosaic_frame(frame: np.ndarray, mask: np.ndarray, block_size: int) -> np.ndarray:
    rect = mask_to_rect(mask)
    if rect is None:
        return frame
    x, y, w, h = rect_to_pixels(rect, frame.shape[1], frame.shape[0])
    output = frame.copy()
    roi = output[y : y + h, x : x + w]
    small_w = max(1, w // max(2, block_size))
    small_h = max(1, h // max(2, block_size))
    small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
    output[y : y + h, x : x + w] = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    return output


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
