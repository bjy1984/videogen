#!/usr/bin/env python3
"""Apply rectangular privacy masks to a single extracted frame."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mask one extracted image frame.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rects", required=True, help="JSON list of normalized rect mask specs.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    image = cv2.imread(args.input, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"Cannot read input image: {args.input}")

    rects = json.loads(args.rects)
    if not isinstance(rects, list) or not rects:
        raise SystemExit("At least one mask rect is required.")

    for raw in rects:
        if not isinstance(raw, dict):
            continue
        apply_mask(image, raw)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(output_path), image):
      raise SystemExit(f"Cannot write output image: {args.output}")
    print(json.dumps({"maskedRects": len(rects)}, ensure_ascii=False))


def apply_mask(frame: np.ndarray, spec: dict[str, Any]) -> None:
    height, width = frame.shape[:2]
    rect = spec.get("rect") if isinstance(spec.get("rect"), dict) else {}
    x = int(clamp_float(rect.get("x"), 0.0, 1.0) * width)
    y = int(clamp_float(rect.get("y"), 0.0, 1.0) * height)
    w = int(clamp_float(rect.get("width"), 0.0, 1.0) * width)
    h = int(clamp_float(rect.get("height"), 0.0, 1.0) * height)
    x = max(0, min(width - 1, x))
    y = max(0, min(height - 1, y))
    w = max(1, min(width - x, w))
    h = max(1, min(height - y, h))
    roi = frame[y : y + h, x : x + w]
    effect = str(spec.get("effect") or "mosaic")
    strength = clamp_float(spec.get("strength"), 0.0, 1.0, 0.85)

    if effect == "solid":
        solid = np.full_like(roi, (0, 0, 0))
        alpha = min(1.0, max(0.35, strength))
        masked = cv2.addWeighted(roi, 1.0 - alpha, solid, alpha, 0)
    elif effect == "blur":
        kernel = max(3, int(9 + strength * 52) | 1)
        masked = cv2.GaussianBlur(roi, (kernel, kernel), 0)
    else:
        block = max(4, int(8 + strength * 34))
        small_w = max(1, w // block)
        small_h = max(1, h // block)
        small = cv2.resize(roi, (small_w, small_h), interpolation=cv2.INTER_LINEAR)
        masked = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    frame[y : y + h, x : x + w] = masked


def clamp_float(value: Any, min_value: float, max_value: float, fallback: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = min_value if fallback is None else fallback
    return max(min_value, min(max_value, number))


if __name__ == "__main__":
    main()
