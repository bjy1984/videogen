#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    parser.add_argument("--input", required=True, help="Input audio file path.")
    parser.add_argument("--output", required=True, help="Output transcript JSON path.")
    parser.add_argument("--model", default="medium", help="faster-whisper model name or local model path.")
    parser.add_argument("--device", default="auto", help="Runtime device, for example auto, cpu, cuda.")
    parser.add_argument("--compute-type", default="default", help="Compute type, for example default, int8, float16.")
    parser.add_argument("--language", default="", help="Optional language code, for example zh.")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments_iter, info = model.transcribe(
        str(input_path),
        language=args.language or None,
        vad_filter=True,
        beam_size=5,
    )

    segments = []
    full_text_parts = []
    for segment in segments_iter:
        text = segment.text.strip()
        if not text:
            continue
        full_text_parts.append(text)
        segments.append(
            {
                "startSec": round(float(segment.start), 3),
                "endSec": round(float(segment.end), 3),
                "text": text,
            }
        )

    payload = {
        "text": "".join(full_text_parts),
        "language": getattr(info, "language", None),
        "durationSec": round(float(getattr(info, "duration", 0) or 0), 3),
        "segments": segments,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
