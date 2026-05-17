#!/usr/bin/env python3
"""OpenCV Zoo ViTTrack masking adapter for Videogen object-mask comparison."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2

from brand_mask import (
    FrameIssue,
    Rect,
    TrackSpec,
    apply_track_mask,
    cleanup_temp,
    compact_issues,
    expand_rect,
    exact_keyframe,
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


MODEL_URL = "https://huggingface.co/opencv/object_tracking_vittrack/resolve/main/object_tracking_vittrack_2023sep_int8bq.onnx"
ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_PATH = ROOT_DIR / "models" / "object_tracking_vittrack_2023sep_int8bq.onnx"


@dataclass
class VitTrackState:
    rect: Rect
    anchor_rect: Rect
    tracker: Any
    lost_count: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply user-guided masks with OpenCV Zoo ViTTrack.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--spec", required=True, help="JSON spec with brand mask tracks.")
    parser.add_argument("--model", default=os.getenv("VIDEOGEN_VITTRACK_MODEL_PATH", str(DEFAULT_MODEL_PATH)), help="ViTTrack ONNX model path.")
    parser.add_argument("--model-url", default=os.getenv("VIDEOGEN_VITTRACK_MODEL_URL", MODEL_URL), help="ViTTrack ONNX download URL.")
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
    model_path = ensure_model(Path(args.model).expanduser(), args.model_url)
    if not input_path.exists():
        raise SystemExit(f"Input video does not exist: {input_path}")
    if not spec_path.exists():
        raise SystemExit(f"Mask spec does not exist: {spec_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    result = process_video(input_path, output_path, spec_path, model_path, args)
    print(json.dumps(result, ensure_ascii=True))
    if args.block_on_red and result["blockedFrames"] > 0:
        raise SystemExit(f"ViTTrack mask has {result['blockedFrames']} red frames; add correction keyframes.")
    return 0


def ensure_model(model_path: Path, model_url: str) -> Path:
    model_path = model_path.resolve()
    if model_path.exists() and model_path.stat().st_size > 0:
        return model_path
    model_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = model_path.with_suffix(model_path.suffix + ".download")
    try:
        request = urllib.request.Request(model_url, headers={"User-Agent": "videogen-vittrack/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response, temp_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        temp_path.replace(model_path)
        return model_path
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        temp_path.unlink(missing_ok=True)
        raise SystemExit(f"ViTTrack model missing and download failed: {error}") from error


def process_video(input_path: Path, output_path: Path, spec_path: Path, model_path: Path, args: argparse.Namespace) -> dict[str, Any]:
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

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_vittrack_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    states: dict[str, VitTrackState] = {}
    issues: list[FrameIssue] = []
    processed_frames = 0
    masked_frames = 0
    skipped_low_confidence_frames: set[int] = set()
    skipped_scale_frames: set[int] = set()
    skipped_tracking_frames: set[int] = set()
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
                rect, confidence, reject_reason, source = resolve_vittrack_rect(track, previous_state, frame, processed_frames, frame_time, model_path)
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
                    if previous_state:
                        states[track.id] = VitTrackState(
                            rect=previous_state.rect,
                            anchor_rect=previous_state.anchor_rect,
                            tracker=previous_state.tracker,
                            lost_count=previous_state.lost_count + 1,
                        )
                    continue
                if rect is None:
                    continue
                if confidence is not None and confidence < track.confidence_threshold:
                    skipped_low_confidence_frames.add(processed_frames)
                    issues.append(
                        FrameIssue(
                            track_id=track.id,
                            frame_index=processed_frames,
                            time=round(frame_time, 3),
                            severity="error",
                            reason=f"{track.label} ViTTrack 置信度不足，已跳过该帧。",
                            confidence=round(confidence, 3),
                        )
                    )
                    if previous_state:
                        states[track.id] = VitTrackState(
                            rect=previous_state.rect,
                            anchor_rect=previous_state.anchor_rect,
                            tracker=previous_state.tracker,
                            lost_count=previous_state.lost_count + 1,
                        )
                    continue

                exact = exact_keyframe(track, processed_frames, frame_time)
                if previous_state and not exact and source == "vittrack":
                    rect = stabilize_rect(rect, previous_state.rect, confidence, track.scale_mode, previous_state.anchor_rect)
                apply_track_mask(output, expand_rect(rect, track.expand_ratio), track, args.block, args.blur, solid_color)
                states[track.id] = build_state(track, previous_state, frame, rect, model_path, exact is not None or previous_state is None)
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
        "recoveredFrames": 0,
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


def resolve_vittrack_rect(
    track: TrackSpec,
    state: VitTrackState | None,
    frame: Any,
    frame_index: int,
    frame_time: float,
    model_path: Path,
) -> tuple[Rect | None, float | None, str | None, str]:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return exact.rect, 1.0, None, "manual"
    if track.track_mode == "manual":
        return None, None, None, "manual"
    if track.track_mode == "static":
        return nearest_track_rect(track, frame_index), 1.0, None, "static"
    interpolated = interpolate_rect(track, frame_index)
    if track.track_mode == "interpolate":
        return interpolated or nearest_track_rect(track, frame_index), 0.9, None, "interpolate"

    if state is None:
        rect = interpolated or nearest_track_rect(track, frame_index)
        return rect, 0.5 if interpolated else 0.42, None, "nearest-init"
    if state.tracker is None:
        return None, 0.0, "ViTTrack 初始化失败", "vittrack"

    try:
        ok, bbox = state.tracker.update(frame)
    except cv2.error as error:
        return None, 0.0, f"ViTTrack 更新失败：{error}", "vittrack"
    confidence = tracking_score(state.tracker)
    if not ok:
        return None, confidence, "ViTTrack 跟丢", "vittrack"
    x, y, w, h = bbox
    candidate = pixels_to_rect((int(round(x)), int(round(y)), int(round(w)), int(round(h))), frame.shape[1], frame.shape[0])
    validated, reason = validate_tracked_rect(candidate, state.rect)
    if validated is None:
        return None, confidence, reason or "ViTTrack 框异常", "vittrack"
    anchored, anchor_reason = validate_anchor_scale(validated, state.anchor_rect)
    if anchored is None:
        return None, confidence, anchor_reason or "ViTTrack 尺度异常", "vittrack"
    return anchored, confidence, None, "vittrack"


def build_state(track: TrackSpec, previous: VitTrackState | None, frame: Any, rect: Rect, model_path: Path, reset_tracker: bool) -> VitTrackState:
    anchor_rect = rect if reset_tracker or previous is None else previous.anchor_rect
    tracker = create_vit_tracker(model_path)
    init_rect = rect if reset_tracker or previous is None else previous.rect
    if not reset_tracker and previous is not None:
        tracker = previous.tracker
    elif tracker is not None:
        x, y, w, h = rect_to_pixels(init_rect, frame.shape[1], frame.shape[0])
        try:
            tracker.init(frame, (x, y, w, h))
        except cv2.error:
            tracker = previous.tracker if previous is not None else None
    return VitTrackState(rect=rect, anchor_rect=anchor_rect, tracker=tracker, lost_count=0)


def create_vit_tracker(model_path: Path) -> Any:
    if not hasattr(cv2, "TrackerVit_create"):
        raise SystemExit("Current OpenCV build does not expose TrackerVit_create; install OpenCV >= 4.8 with ViT tracker support.")
    params = cv2.TrackerVit_Params()
    params.net = str(model_path)
    params.tracking_score_threshold = 0.05
    return cv2.TrackerVit_create(params)


def tracking_score(tracker: Any) -> float:
    try:
        return float(tracker.getTrackingScore())
    except (AttributeError, cv2.error):
        return 0.75


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
