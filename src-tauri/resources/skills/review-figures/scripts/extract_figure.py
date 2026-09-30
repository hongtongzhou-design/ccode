#!/usr/bin/env python3
"""Crop one paper figure by its image objects. Fail-closed: no caption, no guess.

The crop is the union of embedded images beside the caption line, on the
nearer side and in the same column, until the next caption. Page text
outside those image rectangles is not rendered. A vector-only figure has
no image object: exit 5 and cite Fig.n instead of clipping the page.
"""
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


def _caption_line_pat(n: int) -> re.Pattern[str]:
    # 题注常和上一行正文粘在同一个文本块里，不能要求整块以 Figure 开头。
    # 只认单独成行、并且以题注开头的那一行；行内「Figure N shows」不算。
    return re.compile(
        rf"^(?:figure|fig\.?|图)\s*{n}(?!\d)",
        re.IGNORECASE,
    )


def _line_text(line: dict) -> str:
    # PDF 常把 "Fig." 和 "2" 拆进相邻 span，中间还留一个空格 span。
    # 直接拼接会变成 "Fig. 2" 或 "Fig.2"，两种都要能认。
    parts = [span.get("text", "") for span in line.get("spans", [])]
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _caption_line(block: dict, pat: re.Pattern[str]):
    """返回题注行的矩形和原文。正文里顺带提到 Figure N 的行不收。"""
    if block.get("type") != 0:
        return None
    for line in block.get("lines", []):
        text = _line_text(line)
        if pat.match(text):
            box = line.get("bbox")
            if box:
                return box, text
    return None


def _image_rects(page):
    """页面上每个嵌入图的显示矩形。矢量绘制的图没有这项，不另造矩形。"""
    seen: set[tuple[int, int, int, int]] = set()
    rects = []
    for info in page.get_images():
        xref = info[0]
        for rect in page.get_image_rects(xref):
            if rect.width < 8 or rect.height < 8:
                continue
            key = (round(rect.x0), round(rect.y0), round(rect.x1), round(rect.y1))
            if key in seen:
                continue
            seen.add(key)
            rects.append(rect)
    return rects


def _neighbor_captions(page, caption, fig: int):
    """同一栏里、这条题注上下两侧最近的其他题注边界。"""
    pat = re.compile(r"^(?:figure|fig\.?|图)\s*(\d+)(?!\d)", re.IGNORECASE)
    above = page.rect.y0
    below = page.rect.y1
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            match = pat.match(_line_text(line))
            if not match or int(match.group(1)) == fig:
                continue
            box = line.get("bbox") or block["bbox"]
            same_column = box[2] > caption.x0 and box[0] < caption.x1
            if not same_column:
                continue
            if box[3] <= caption.y0 + 2:
                above = max(above, box[3])
            elif box[1] >= caption.y1 - 2:
                below = min(below, box[1])
    return above, below


def _ink_fraction(samples, w, h, n, box):
    x0, y0, x1, y1 = box
    ink = 0
    total = 0
    for y in range(y0, y1):
        row = samples[y * w * n : (y + 1) * w * n]
        for x in range(x0, x1):
            i = x * n
            total += 1
            if min(row[i], row[i + 1], row[i + 2]) < 248:
                ink += 1
    return ink / total if total else 1


def _split_cells(pix):
    """沿够宽的白槽切开。切出来的块必须自己有内容，并且不贴着被切断的线。"""
    samples = pix.samples
    w, h, n = pix.width, pix.height, pix.n
    if w < 80 or h < 80 or n < 3:
        return []
    ink_row = [0] * h
    ink_col = [0] * w
    for y in range(h):
        row = samples[y * w * n : (y + 1) * w * n]
        for x in range(w):
            i = x * n
            if min(row[i], row[i + 1], row[i + 2]) < 248:
                ink_row[y] += 1
                ink_col[x] += 1
    def gaps(counts, limit, total):
        found = []
        start = None
        thresh = total * 0.012
        for i, count in enumerate(counts):
            empty = count <= thresh
            if empty and start is None:
                start = i
            elif not empty and start is not None:
                if i - start >= limit:
                    found.append((start, i))
                start = None
        return found
    row_gaps = [g for g in gaps(ink_row, max(14, h // 40), w) if g[0] > h * 0.08 and g[1] < h * 0.92]
    col_gaps = [g for g in gaps(ink_col, max(14, w // 40), h) if g[0] > w * 0.08 and g[1] < w * 0.92]
    if not row_gaps and not col_gaps:
        return []
    def bands(length, gutters):
        cuts = [0]
        for start, end in gutters:
            cuts.extend((start, end))
        cuts.append(length)
        out = []
        for i in range(0, len(cuts) - 1, 2):
            a, b = cuts[i], cuts[i + 1]
            if b - a > length * 0.12:
                out.append((a, b))
        return out
    rb, cb = bands(h, row_gaps), bands(w, col_gaps)
    if len(rb) * len(cb) < 2:
        return []
    cells = []
    for y0, y1 in rb:
        for x0, x1 in cb:
            box = (x0, y0, x1, y1)
            if _ink_fraction(samples, w, h, n, box) < 0.02:
                return []
            cells.append(box)
    return cells


def extract(pdf: Path, fig: int, out: Path, dpi: int, panel: str | None) -> None:
    fitz = _need_fitz()
    doc = fitz.open(pdf)
    pat = _caption_line_pat(fig)
    found_caption = False
    try:
        for page in doc:
            captions = []
            for block in page.get_text("dict").get("blocks", []):
                hit = _caption_line(block, pat)
                if hit:
                    box, text = hit
                    captions.append((fitz.Rect(box), text))
            if not captions:
                continue
            # 「Fig. 4 …」「Figure 4.」是题注；「Figure 4 further」是正文叙述。
            def caption_rank(item: tuple) -> tuple[int, float]:
                rect, text = item
                titled = bool(re.match(r"^(?:fig\.|图|figure\s+\d+\s*[.:：])", text, re.I))
                return (0 if titled else 1, rect.y0)
            captions.sort(key=caption_rank)
            cap = None
            for candidate, _text in captions:
                if candidate.y0 < 36:
                    continue
                cap = candidate
                break
            if cap is None:
                continue
            if cap.y0 < 36:
                # 页眉刊名。题注本身可以很短（只有 “Fig. 2”），不能按宽度滤掉。
                continue
            found_caption = True
            above, below = _neighbor_captions(page, cap, fig)
            above_rects = []
            below_rects = []
            for rect in _image_rects(page):
                # 短题注（“Fig. 2”）比图窄，用中心是否落在对方范围内判断同栏。
                center_in_caption = cap.x0 - 8 <= (rect.x0 + rect.x1) / 2 <= cap.x1 + 8
                caption_in_image = rect.x0 - 8 <= (cap.x0 + cap.x1) / 2 <= rect.x1 + 8
                if not (center_in_caption or caption_in_image):
                    continue
                if rect.width < 40 or rect.height < 40:
                    continue
                if rect.y1 <= cap.y0 + 6 and rect.y0 >= above - 2:
                    above_rects.append(rect)
                elif rect.y0 >= cap.y1 - 6 and rect.y1 <= below + 2:
                    below_rects.append(rect)
            # 图在题注上或题注下都常见。取离题注更近的那一侧，不把另一张图并进来。
            def nearest(rects, edge):
                return min(rects, key=lambda r: abs((r.y0 + r.y1) / 2 - edge)) if rects else None
            up = nearest(above_rects, cap.y0)
            down = nearest(below_rects, cap.y1)
            if up and down:
                chosen = above_rects if abs(up.y1 - cap.y0) <= abs(down.y0 - cap.y1) else below_rects
            else:
                chosen = above_rects or below_rects
            if not chosen:
                continue
            clip = chosen[0]
            for rect in chosen[1:]:
                clip |= rect
            # 只留图像矩形。向四周扩 2 pt 吃进抗锯齿，不扩到旁边的正文行。
            clip = fitz.Rect(clip.x0 - 2, clip.y0 - 2, clip.x1 + 2, clip.y1 + 2) & page.rect
            area = clip.width * clip.height
            page_area = page.rect.width * page.rect.height
            if area <= 0 or area / page_area > 0.85:
                print("图像对象接近整页，拒绝当作单图", file=sys.stderr)
                sys.exit(4)
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip, alpha=False)
            if panel:
                cells = _split_cells(pix)
                index = ord(panel.lower()) - ord("a")
                if index < 0 or index >= len(cells):
                    print(
                        f"Fig. {fig} 是一整张多联图，切不出 ({panel})。改为引用 Fig.{fig}({panel})，不要把整张放进拼板",
                        file=sys.stderr,
                    )
                    sys.exit(6)
                x0, y0, x1, y1 = cells[index]
                clipped = fitz.Pixmap(pix.colorspace, fitz.IRect(x0, y0, x1, y1), pix.alpha)
                clipped.copy(pix, fitz.IRect(x0, y0, x1, y1))
                pix = clipped
            out.parent.mkdir(parents=True, exist_ok=True)
            pix.save(str(out))
            print(out)
            return
    finally:
        doc.close()
    if found_caption:
        print(f"Fig. {fig} 题注旁没有可分离的图像对象，改为引用 Fig.{fig}", file=sys.stderr)
        sys.exit(5)
    print(f"未找到 Fig./Figure/图 {fig} 题注", file=sys.stderr)
    sys.exit(3)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pdf", type=Path, required=True)
    p.add_argument("--fig", type=int, required=True)
    p.add_argument("--panel", default="", help="只用多联图里的一块，如 f。切不出就失败，不回退整张")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--dpi", type=int, default=300)
    a = p.parse_args()
    if a.fig < 1:
        p.error("--fig 必须 ≥ 1")
    panel = a.panel.strip().lower()[:1]
    if panel and panel not in "abcdefgh":
        p.error("--panel 用 a–h")
    if not a.pdf.is_file():
        print(f"找不到 PDF：{a.pdf}", file=sys.stderr)
        sys.exit(1)
    extract(a.pdf, a.fig, a.out, a.dpi, panel or None)


if __name__ == "__main__":
    main()
