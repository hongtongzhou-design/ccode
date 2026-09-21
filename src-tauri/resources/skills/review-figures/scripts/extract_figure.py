#!/usr/bin/env python3
"""Crop one paper figure by caption. Fail-closed: no caption match, no guess."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def _need_fitz() -> object:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("需要 PyMuPDF：pip install pymupdf", file=sys.stderr)
        sys.exit(2)
    return fitz


def _caption_pat(n: int) -> re.Pattern[str]:
    return re.compile(
        rf"(?:figure|fig\.?|图)\s*{n}(?:\b|[.:：])",
        re.IGNORECASE,
    )


def _block_text(block: dict) -> str:
    if block.get("type") != 0:
        return ""
    parts: list[str] = []
    for line in block.get("lines", []):
        for span in line.get("spans", []):
            parts.append(span.get("text", ""))
    return "".join(parts)


def extract(pdf: Path, fig: int, out: Path, dpi: int) -> None:
    fitz = _need_fitz()
    doc = fitz.open(pdf)
    pat = _caption_pat(fig)
    try:
        for page in doc:
            cap = None
            for block in page.get_text("dict").get("blocks", []):
                if pat.search(_block_text(block)):
                    cap = fitz.Rect(block["bbox"])
                    break
            if cap is None:
                continue
            clips = []
            for info in page.get_images():
                for rect in page.get_image_rects(info[0]):
                    if rect.y1 <= cap.y0 + 4 and rect.y0 < cap.y0:
                        clips.append(rect)
            if clips:
                clip = clips[0]
                for rect in clips[1:]:
                    clip |= rect
            else:
                top = max(page.rect.y0, cap.y0 - page.rect.height * 0.45)
                clip = fitz.Rect(page.rect.x0 + 18, top, page.rect.x1 - 18, cap.y0 - 4)
            area = clip.width * clip.height
            page_area = page.rect.width * page.rect.height
            if area <= 0 or area / page_area > 0.85:
                print("裁切区域接近整页，拒绝猜测", file=sys.stderr)
                sys.exit(4)
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip, alpha=False)
            out.parent.mkdir(parents=True, exist_ok=True)
            pix.save(str(out))
            print(out)
            return
    finally:
        doc.close()
    print(f"未找到 Fig./Figure/图 {fig} 题注", file=sys.stderr)
    sys.exit(3)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pdf", type=Path, required=True)
    p.add_argument("--fig", type=int, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--dpi", type=int, default=300)
    a = p.parse_args()
    if a.fig < 1:
        p.error("--fig 必须 ≥ 1")
    if not a.pdf.is_file():
        print(f"找不到 PDF：{a.pdf}", file=sys.stderr)
        sys.exit(1)
    extract(a.pdf, a.fig, a.out, a.dpi)


if __name__ == "__main__":
    main()
