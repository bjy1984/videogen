#!/usr/bin/env python3
"""External tracker command adapter for Videogen mask comparison engines."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run an external object tracking mask backend.")
    parser.add_argument("--engine", required=True, help="Tracking engine id reported in the summary.")
    parser.add_argument("--display-name", required=True, help="User-facing engine name.")
    parser.add_argument("--backend-env", required=True, help="Environment variable containing the backend command template.")
    parser.add_argument("--input", required=True, help="Input video path.")
    parser.add_argument("--output", required=True, help="Output video path.")
    parser.add_argument("--spec", required=True, help="JSON spec with mask tracks.")
    parser.add_argument("--block-on-red", action="store_true", help="Exit non-zero if backend reports blocked frames.")
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

    command_template = os.getenv(args.backend_env, "").strip()
    if not command_template:
        raise SystemExit(
            f"{args.display_name} 未配置。请设置 {args.backend_env}，命令必须包含 "
            "{input}、{output}、{spec} 占位符。"
        )
    required = ("{input}", "{output}", "{spec}")
    if not all(token in command_template for token in required):
        raise SystemExit(f"{args.backend_env} 必须包含 {{input}}、{{output}}、{{spec}} 占位符。")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    command = (
        command_template
        .replace("{input}", shlex.quote(str(input_path)))
        .replace("{output}", shlex.quote(str(output_path)))
        .replace("{spec}", shlex.quote(str(spec_path)))
    )
    completed = subprocess.run(command, shell=True, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise SystemExit(f"{args.display_name} 后端命令失败：{completed.returncode}{'，' + detail if detail else ''}")
    if not output_path.exists():
        raise SystemExit(f"{args.display_name} 后端命令完成，但没有生成输出视频：{output_path}")

    summary = parse_summary(completed.stdout) or {}
    if not isinstance(summary, dict):
        summary = {}
    summary.setdefault("trackingEngine", args.engine)
    summary.setdefault("elapsedSec", round(time.time() - started_at, 3))
    summary.setdefault("output", str(output_path))
    print(json.dumps(summary, ensure_ascii=True))
    blocked_frames = summary.get("blockedFrames")
    if args.block_on_red and isinstance(blocked_frames, int) and blocked_frames > 0:
        raise SystemExit(f"{args.display_name} mask has {blocked_frames} red frames; add correction keyframes.")
    return 0


def parse_summary(stdout: str) -> Any:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    for line in reversed(lines):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
