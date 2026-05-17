#!/usr/bin/env python3
"""MixFormerV2-S ONNX mask tracker for Videogen object-mask comparison."""

from __future__ import annotations

import argparse
import json
import math
import os
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
    cleanup_temp,
    compact_issues,
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
    rect_to_pixels,
    stabilize_rect,
    validate_anchor_scale,
    validate_tracked_rect,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_CANDIDATES = [
    ROOT_DIR / "models" / "mixformerv2s.onnx",
    Path("/Volumes/Volume/project/gimbal/android/app/src/main/assets/tracking/mixformerv2s/mixformerv2s.onnx"),
]
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)
TEMPLATE_SIZE = 112
SEARCH_SIZE = 224
TEMPLATE_CONTEXT_SCALE = 2.0
SEARCH_CONTEXT_SCALE = 4.0


@dataclass
class MixFormerWindow:
    left: float
    top: float
    side: float


@dataclass
class MixFormerState:
    rect: Rect
    anchor_rect: Rect
    template_tensor: np.ndarray
    lost_count: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply user-guided masks with MixFormerV2-S ONNX tracking.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--spec", required=True, help="JSON spec with brand mask tracks.")
    parser.add_argument("--model", default=os.getenv("VIDEOGEN_MIXFORMER_MODEL_PATH", ""), help="MixFormerV2-S ONNX model path.")
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
    model_path = resolve_model_path(args.model)
    if not input_path.exists():
        raise SystemExit(f"Input video does not exist: {input_path}")
    if not spec_path.exists():
        raise SystemExit(f"Mask spec does not exist: {spec_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    result = process_video(input_path, output_path, spec_path, model_path, args)
    print(json.dumps(result, ensure_ascii=True))
    if args.block_on_red and result["blockedFrames"] > 0:
        raise SystemExit(f"MixFormerV2-S mask has {result['blockedFrames']} red frames; add correction keyframes.")
    return 0


def resolve_model_path(model_arg: str) -> Path:
    candidates = [Path(model_arg).expanduser()] if model_arg else []
    candidates.extend(DEFAULT_MODEL_CANDIDATES)
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.exists() and resolved.stat().st_size > 0:
            return resolved
    raise SystemExit(
        "MixFormerV2-S model not found. Set VIDEOGEN_MIXFORMER_MODEL_PATH or place "
        "mixformerv2s.onnx at models/mixformerv2s.onnx."
    )


def load_onnx_session(model_path: Path) -> Any:
    try:
        import onnxruntime as ort
    except ModuleNotFoundError as error:
        raise SystemExit(
            "onnxruntime is not installed. Install with: "
            ".venv-face-mosaic/bin/python -m pip install onnxruntime"
        ) from error
    return ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])


def process_video(
    input_path: Path,
    output_path: Path,
    spec_path: Path,
    model_path: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
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

    session = load_onnx_session(model_path)
    input_names = {item.name for item in session.get_inputs()}
    output_names = [item.name for item in session.get_outputs()]
    if "template" not in input_names or "search" not in input_names:
        raise SystemExit("MixFormerV2-S model inputs must include template and search.")
    if len(output_names) < 2:
        raise SystemExit("MixFormerV2-S model must expose box and score outputs.")

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_mixformer_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    states: dict[str, MixFormerState] = {}
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
            frame_time = processed_frames / fps if fps else 0.0
            output = frame.copy()
            frame_masked = False

            for track in tracks:
                previous_state = states.get(track.id)
                rect, confidence, reject_reason, source, reset_template = resolve_mixformer_rect(
                    track,
                    previous_state,
                    session,
                    frame,
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
                            reason=f"{track.label} MixFormerV2-S 置信度不足，已跳过该帧。",
                            confidence=round(confidence, 3),
                        )
                    )
                    if not exact:
                        mark_track_lost(states, track, previous_state)
                        continue
                if previous_state and not exact and source == "mixformer":
                    rect = stabilize_rect(rect, previous_state.rect, confidence, track.scale_mode, previous_state.anchor_rect)
                apply_track_mask(output, expand_rect(rect, track.expand_ratio), track, args.block, args.blur, solid_color)
                if previous_state and previous_state.lost_count > 0:
                    recovered_frames.add(processed_frames)
                states[track.id] = build_state(track, previous_state, frame, rect, reset_template or previous_state is None)
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


def resolve_mixformer_rect(
    track: TrackSpec,
    state: MixFormerState | None,
    session: Any,
    frame: np.ndarray,
    frame_index: int,
    frame_time: float,
) -> tuple[Rect | None, float | None, str | None, str, bool]:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return exact.rect, 1.0, None, "manual", True
    if track.track_mode == "manual":
        return None, None, None, "manual", False
    if track.track_mode == "static":
        return nearest_track_rect(track, frame_index), 1.0, None, "static", False
    interpolated = interpolate_rect(track, frame_index)
    if track.track_mode == "interpolate":
        return interpolated or nearest_track_rect(track, frame_index), 0.9, None, "interpolate", False
    if state is None:
        return None, 0.0, "MixFormerV2-S 尚未获得人工关键帧", "mixformer", False

    rect, confidence, reason = track_with_mixformer(session, frame, state)
    if rect is None:
        return None, confidence, reason or "MixFormerV2-S 跟丢", "mixformer", False
    if confidence < 0.05:
        return None, confidence, "MixFormerV2-S 跟踪得分过低", "mixformer", False
    validated, validate_reason = validate_tracked_rect(rect, state.rect)
    if validated is None:
        return None, confidence, validate_reason or "MixFormerV2-S 框异常", "mixformer", False
    anchored, anchor_reason = validate_anchor_scale(validated, state.anchor_rect)
    if anchored is None:
        return None, confidence, anchor_reason or "MixFormerV2-S 尺度异常", "mixformer", False
    return anchored, confidence, None, "mixformer", False


def track_with_mixformer(session: Any, frame: np.ndarray, state: MixFormerState) -> tuple[Rect | None, float, str | None]:
    height, width = frame.shape[:2]
    search_scale = SEARCH_CONTEXT_SCALE + min(2.0, state.lost_count * 0.35)
    x, y, w, h = rect_to_pixels(state.rect, width, height)
    search_window = build_tracking_window(x, y, x + w, y + h, search_scale)
    search_tensor = tensor_from_window(frame, search_window, SEARCH_SIZE)
    try:
        outputs = session.run(None, {"template": state.template_tensor, "search": search_tensor})
    except Exception as error:
        return None, 0.0, f"MixFormerV2-S 推理失败：{error}"
    if len(outputs) < 2:
        return None, 0.0, "MixFormerV2-S 未返回 box/score"
    box_values = np.asarray(outputs[0]).reshape(-1)
    score_values = np.asarray(outputs[1]).reshape(-1)
    if box_values.size < 4 or score_values.size < 1:
        return None, 0.0, "MixFormerV2-S 输出为空"
    if not np.all(np.isfinite(box_values[:4])) or not np.all(np.isfinite(score_values[:1])):
        return None, 0.0, "MixFormerV2-S 输出包含非法数值"
    confidence = sigmoid(float(score_values[0]))
    cx_norm, cy_norm, w_norm, h_norm = [float(value) for value in box_values[:4]]
    if w_norm <= 0.0 or h_norm <= 0.0:
        return None, confidence, "MixFormerV2-S 输出尺寸无效"
    cx = search_window.left + cx_norm * search_window.side
    cy = search_window.top + cy_norm * search_window.side
    box_w = w_norm * search_window.side
    box_h = h_norm * search_window.side
    candidate = pixels_to_rect(
        (
            int(round(cx - box_w / 2)),
            int(round(cy - box_h / 2)),
            max(1, int(round(box_w))),
            max(1, int(round(box_h))),
        ),
        width,
        height,
    )
    return candidate, confidence, None


def build_state(
    track: TrackSpec,
    previous: MixFormerState | None,
    frame: np.ndarray,
    rect: Rect,
    reset_template: bool,
) -> MixFormerState:
    if not reset_template and previous is not None:
        return MixFormerState(rect=rect, anchor_rect=previous.anchor_rect, template_tensor=previous.template_tensor, lost_count=0)
    height, width = frame.shape[:2]
    x, y, w, h = rect_to_pixels(rect, width, height)
    template_window = build_tracking_window(x, y, x + w, y + h, TEMPLATE_CONTEXT_SCALE)
    template_tensor = tensor_from_window(frame, template_window, TEMPLATE_SIZE)
    return MixFormerState(rect=rect, anchor_rect=rect, template_tensor=template_tensor, lost_count=0)


def mark_track_lost(states: dict[str, MixFormerState], track: TrackSpec, state: MixFormerState | None) -> None:
    if state is None:
        return
    states[track.id] = MixFormerState(
        rect=state.rect,
        anchor_rect=state.anchor_rect,
        template_tensor=state.template_tensor,
        lost_count=state.lost_count + 1,
    )


def build_tracking_window(left: float, top: float, right: float, bottom: float, context_scale: float) -> MixFormerWindow:
    normalized_left = min(left, right)
    normalized_top = min(top, bottom)
    normalized_right = max(left, right)
    normalized_bottom = max(top, bottom)
    box_width = max(1.0, normalized_right - normalized_left)
    box_height = max(1.0, normalized_bottom - normalized_top)
    center_x = (normalized_left + normalized_right) * 0.5
    center_y = (normalized_top + normalized_bottom) * 0.5
    side = max(1.0, math.ceil(math.sqrt(box_width * box_height) * max(1.0, context_scale)))
    return MixFormerWindow(round(center_x - side * 0.5), round(center_y - side * 0.5), side)


def tensor_from_window(frame: np.ndarray, window: MixFormerWindow, output_size: int) -> np.ndarray:
    left = int(round(window.left))
    top = int(round(window.top))
    side = max(1, int(round(window.side)))
    height, width = frame.shape[:2]
    right = left + side
    bottom = top + side
    crop_left = max(0, left)
    crop_top = max(0, top)
    crop_right = min(width, right)
    crop_bottom = min(height, bottom)
    if crop_right <= crop_left or crop_bottom <= crop_top:
        patch = np.full((side, side, 3), 128, dtype=np.uint8)
    else:
        crop = frame[crop_top:crop_bottom, crop_left:crop_right]
        patch = cv2.copyMakeBorder(
            crop,
            crop_top - top,
            bottom - crop_bottom,
            crop_left - left,
            right - crop_right,
            cv2.BORDER_CONSTANT,
            value=(128, 128, 128),
        )
    resized = cv2.resize(patch, (output_size, output_size), interpolation=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    chw = np.transpose(rgb, (2, 0, 1))
    normalized = (chw - MEAN) / STD
    return normalized[np.newaxis, ...].astype(np.float32)


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
