#!/usr/bin/env python3
"""Cityscapes semantic-segmentation assisted masking for user boxed regions."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch

from brand_mask import (
    FrameIssue,
    Rect,
    apply_mask,
    block_size_for_strength,
    blur_size_for_strength,
    cleanup_temp,
    compact_issues,
    exact_keyframe,
    expand_rect,
    interpolate_rect,
    issue_to_dict,
    merge_audio,
    nearest_track_rect,
    parse_solid_color,
    parse_tracks,
    rect_to_pixels,
    solid_alpha_for_strength,
)


CITYSCAPES_LABELS = [
    "road",
    "sidewalk",
    "building",
    "wall",
    "fence",
    "pole",
    "traffic light",
    "traffic sign",
    "vegetation",
    "terrain",
    "sky",
    "person",
    "rider",
    "car",
    "truck",
    "bus",
    "train",
    "motorcycle",
    "bicycle",
]

DEFAULT_ALLOWED_CLASSES = "person,rider,car,truck,bus,train,motorcycle,bicycle,traffic light,traffic sign"


class DDRNetSegmenter:
    def __init__(self, max_side: int):
        from qai_hub_models.models._shared.segmentation.app import SegmentationApp
        from qai_hub_models.models.ddrnet23_slim.model import DDRNet
        from qai_hub_models.utils.asset_loaders import always_answer_prompts

        with always_answer_prompts(True):
            self.model = DDRNet.from_pretrained()
        self.model.eval()
        self.app = SegmentationApp(self.model)
        self.max_side = max(256, max_side)

    def segment(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        resized, resized_width, resized_height = resize_for_inference(rgb, self.max_side)
        with torch.no_grad():
            logits = self.app.segment_image(resized, raw_output=True)
        class_map = np.argmax(logits, axis=1)[0].astype(np.uint8)
        if class_map.shape[:2] != (resized_height, resized_width):
            class_map = cv2.resize(class_map, (resized_width, resized_height), interpolation=cv2.INTER_NEAREST)
        return cv2.resize(class_map, (width, height), interpolation=cv2.INTER_NEAREST)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Apply DDRNet semantic masks inside user boxed regions.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--spec", required=True, help="JSON spec with brand mask tracks.")
    parser.add_argument("--classes", default=DEFAULT_ALLOWED_CLASSES, help="Comma-separated Cityscapes labels to accept, or 'any'.")
    parser.add_argument("--min-class-ratio", type=float, default=0.03, help="Minimum target class coverage inside a keyframe box.")
    parser.add_argument("--min-mask-ratio", type=float, default=0.01, help="Minimum target mask coverage inside the current box.")
    parser.add_argument("--infer-max-side", type=int, default=960, help="Resize longest side before DDRNet inference.")
    parser.add_argument("--mask-dilate", type=int, default=3, help="Dilate semantic mask by this many pixels.")
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
        raise SystemExit(f"DDRNet mask has {result['blockedFrames']} red frames; choose a Cityscapes object or add another engine.")
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

    allowed_classes = parse_class_filter(args.classes)
    segmenter = DDRNetSegmenter(args.infer_max_side)
    solid_color = parse_solid_color(args.solid_color)

    temp_dir = Path(tempfile.mkdtemp(prefix="videogen_ddrnet_mask_"))
    temp_video = temp_dir / "video_no_audio.mp4"
    writer = cv2.VideoWriter(str(temp_video), cv2.VideoWriter_fourcc(*args.codec), fps, (width, height))
    if not writer.isOpened():
        capture.release()
        raise SystemExit("Could not create temporary video writer.")

    class_assignments: dict[str, set[int]] = {}
    issues: list[FrameIssue] = []
    processed_frames = 0
    masked_frames = 0
    semantic_mask_pixels = 0
    started_at = time.time()

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_time = processed_frames / fps if fps else 0.0
            class_map = segmenter.segment(frame)
            output = frame.copy()
            frame_masked = False

            for track in tracks:
                rect = resolve_rect(track, processed_frames, frame_time)
                is_exact = exact_keyframe(track, processed_frames, frame_time) is not None
                if is_exact or track.id not in class_assignments:
                    selected = select_classes_for_track(class_map, rect, allowed_classes, args.min_class_ratio)
                    if selected:
                        class_assignments[track.id] = selected
                    elif track.id not in class_assignments:
                        issues.append(
                            make_issue(track.id, processed_frames, frame_time, f"{track.label} 框内没有可用的 DDRNet 语义类别，已跳过。")
                        )
                        continue

                class_ids = class_assignments.get(track.id, set())
                if not class_ids:
                    continue
                mask = constrained_semantic_mask(class_map, class_ids, expand_rect(rect, track.expand_ratio), args.mask_dilate)
                x, y, w, h = rect_to_pixels(expand_rect(rect, track.expand_ratio), width, height)
                roi_pixels = max(1, w * h)
                mask_pixels = int(np.count_nonzero(mask))
                if mask_pixels / roi_pixels < args.min_mask_ratio:
                    issues.append(
                        make_issue(track.id, processed_frames, frame_time, f"{track.label} 当前帧语义 mask 覆盖不足，已跳过。", 0.0)
                    )
                    continue
                apply_binary_mask(output, mask, track.effect, args.block, args.blur, solid_color, track.strength)
                semantic_mask_pixels += mask_pixels
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
        "semanticMaskPixels": semantic_mask_pixels,
        "semanticClasses": summarize_assignments(class_assignments),
        "skippedTrackingFrames": len(error_frames),
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


def resize_for_inference(rgb: np.ndarray, max_side: int) -> tuple[np.ndarray, int, int]:
    height, width = rgb.shape[:2]
    scale = min(1.0, max_side / float(max(width, height)))
    resized_width = round_to_stride(max(64, int(round(width * scale))), 64)
    resized_height = round_to_stride(max(64, int(round(height * scale))), 64)
    return cv2.resize(rgb, (resized_width, resized_height), interpolation=cv2.INTER_AREA), resized_width, resized_height


def round_to_stride(value: int, stride: int) -> int:
    return max(stride, int(round(value / stride)) * stride)


def parse_class_filter(value: str) -> set[int] | None:
    if value.strip().lower() == "any":
        return None
    allowed: set[int] = set()
    by_name = {label: index for index, label in enumerate(CITYSCAPES_LABELS)}
    for item in value.split(","):
        label = item.strip().lower()
        if not label:
            continue
        if label.isdigit():
            index = int(label)
            if 0 <= index < len(CITYSCAPES_LABELS):
                allowed.add(index)
            continue
        if label in by_name:
            allowed.add(by_name[label])
    return allowed


def resolve_rect(track: Any, frame_index: int, frame_time: float) -> Rect:
    exact = exact_keyframe(track, frame_index, frame_time)
    if exact:
        return exact.rect
    if track.track_mode == "static":
        return nearest_track_rect(track, frame_index)
    return interpolate_rect(track, frame_index) or nearest_track_rect(track, frame_index)


def select_classes_for_track(class_map: np.ndarray, rect: Rect, allowed_classes: set[int] | None, min_ratio: float) -> set[int]:
    x, y, w, h = rect_to_pixels(rect, class_map.shape[1], class_map.shape[0])
    roi = class_map[y : y + h, x : x + w]
    if roi.size == 0:
        return set()
    labels, counts = np.unique(roi, return_counts=True)
    total = float(roi.size)
    ranked = sorted(zip(labels.tolist(), counts.tolist(), strict=False), key=lambda item: item[1], reverse=True)
    selected: set[int] = set()
    for label_id, count in ranked:
        if allowed_classes is not None and int(label_id) not in allowed_classes:
            continue
        if count / total >= min_ratio:
            selected.add(int(label_id))
        if selected:
            break
    return selected


def constrained_semantic_mask(class_map: np.ndarray, class_ids: set[int], rect: Rect, dilate: int) -> np.ndarray:
    mask = np.isin(class_map, list(class_ids))
    constrained = np.zeros_like(mask, dtype=bool)
    x, y, w, h = rect_to_pixels(rect, class_map.shape[1], class_map.shape[0])
    constrained[y : y + h, x : x + w] = mask[y : y + h, x : x + w]
    if dilate > 0 and np.any(constrained):
        kernel_size = max(1, int(dilate))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size * 2 + 1, kernel_size * 2 + 1))
        constrained = cv2.dilate(constrained.astype(np.uint8), kernel, iterations=1).astype(bool)
    return constrained


def apply_binary_mask(
    frame: np.ndarray,
    mask: np.ndarray,
    effect: str,
    block_size: int,
    blur_size: int,
    solid_color: tuple[int, int, int],
    strength: float = 0.85,
) -> None:
    ys, xs = np.where(mask)
    if ys.size == 0 or xs.size == 0:
        return
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    rect = (x1 / frame.shape[1], y1 / frame.shape[0], (x2 - x1) / frame.shape[1], (y2 - y1) / frame.shape[0])
    patch = frame.copy()
    apply_mask(
        patch,
        rect,
        effect,
        block_size_for_strength(block_size, strength),
        blur_size_for_strength(blur_size, strength),
        solid_color,
        solid_alpha_for_strength(strength),
    )
    frame[mask] = patch[mask]


def make_issue(track_id: str, frame_index: int, frame_time: float, reason: str, confidence: float | None = None) -> FrameIssue:
    return FrameIssue(
        track_id=track_id,
        frame_index=frame_index,
        time=round(frame_time, 3),
        severity="error",
        reason=reason,
        confidence=confidence,
    )


def summarize_assignments(class_assignments: dict[str, set[int]]) -> dict[str, list[str]]:
    return {
        track_id: [CITYSCAPES_LABELS[index] for index in sorted(class_ids) if 0 <= index < len(CITYSCAPES_LABELS)]
        for track_id, class_ids in class_assignments.items()
    }


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
