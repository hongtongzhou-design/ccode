#!/usr/bin/env python3
"""Compose cropped panels: equal height, no stretch, (a)(b) labels, white ground."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _need_pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("需要 Pillow：pip install pillow", file=sys.stderr)
        sys.exit(2)
    return Image, ImageDraw, ImageFont


def assemble(inputs: list[Path], out: Path, width_cm: float, dpi: int, gap_mm: float) -> None:
    Image, ImageDraw, ImageFont = _need_pil()
    images = [Image.open(p).convert("RGB") for p in inputs]
    if not images:
        print("没有输入图", file=sys.stderr)
        sys.exit(1)
    target_h = min(im.height for im in images)
    scaled = []
    for im in images:
        ratio = target_h / im.height
        w = max(1, int(im.width * ratio))
        scaled.append(im.resize((w, target_h), Image.Resampling.LANCZOS))
    gap = max(0, int(dpi * gap_mm / 25.4))
    pad = max(8, int(dpi * 0.12))
    total_w = sum(im.width for im in scaled) + gap * (len(scaled) - 1) + pad * 2
    total_h = target_h + pad * 2
    canvas = Image.new("RGB", (total_w, total_h), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("Arial.ttf", max(18, int(dpi * 8 / 72)))
    except OSError:
        font = ImageFont.load_default()
    x = pad
    letters = "abcdefghijklmnopqrstuvwxyz"
    for i, im in enumerate(scaled):
        canvas.paste(im, (x, pad))
        label = f"({letters[i]})"
        draw.text((x + 4, pad + 2), label, fill=(0, 0, 0), font=font)
        x += im.width + gap
    target_w_px = max(1, int(width_cm / 2.54 * dpi))
    if canvas.width != target_w_px:
        h = max(1, int(canvas.height * target_w_px / canvas.width))
        canvas = canvas.resize((target_w_px, h), Image.Resampling.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, dpi=(dpi, dpi))
    print(out)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--inputs", nargs="+", type=Path, required=True)
    p.add_argument("--width-cm", type=float, default=8.5)
    p.add_argument("--dpi", type=int, default=300)
    p.add_argument("--gap-mm", type=float, default=2.5)
    a = p.parse_args()
    missing = [str(p) for p in a.inputs if not p.is_file()]
    if missing:
        print("缺少源图：" + "、".join(missing), file=sys.stderr)
        sys.exit(1)
    assemble(a.inputs, a.out, a.width_cm, a.dpi, a.gap_mm)


if __name__ == "__main__":
    main()
