#!/usr/bin/env python3
"""Recommend a citation style from project PDFs. Never picks one by itself."""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import zlib
from pathlib import Path

NUMERIC = re.compile(r"\[(\d{1,3})\]")
AUTHOR = re.compile(
    r"\([A-Z][A-Za-z'’\-]+(?:\s+et\s+al\.?)?,?\s+(?:19|20)\d{2}[a-z]?\)"
)
CHOSEN = re.compile(r"^选定：[ \t]*(.*)$", re.M)
MAX_PDFS = 12
MAX_BYTES = 6 * 1024 * 1024


def pdf_text(data: bytes) -> str:
    chunks: list[bytes] = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        raw = match.group(1)
        chunk = raw
        try:
            chunk = zlib.decompress(raw)
        except zlib.error:
            pass
        chunks.append(chunk)
    blob = b"\n".join(chunks) if chunks else data
    pieces: list[str] = []
    for match in re.finditer(rb"\((?:\\.|[^\\)]){1,400}\)", blob):
        raw = match.group(0)[1:-1]
        raw = raw.replace(b"\\n", b" ").replace(b"\\(", b"(").replace(b"\\)", b")").replace(b"\\\\", b"\\")
        pieces.append(raw.decode("latin1", "ignore"))
    return " ".join(pieces)


def text_of(path: Path) -> str:
    tool = shutil.which("pdftotext")
    if tool:
        done = subprocess.run(
            [tool, "-f", "1", "-l", "2", "-q", str(path), "-"],
            capture_output=True,
            timeout=20,
        )
        if done.returncode == 0 and done.stdout.strip():
            return done.stdout.decode("utf-8", "ignore")
    data = path.read_bytes()
    if len(data) > MAX_BYTES:
        data = data[:MAX_BYTES]
    return pdf_text(data)


def vote(text: str) -> str:
    numeric = len(NUMERIC.findall(text))
    author = len(AUTHOR.findall(text))
    if numeric >= 2 and numeric >= author:
        return "编号"
    if author >= 1 and author > numeric:
        return "作者-年"
    return "看不清"


def collect(root: Path) -> list[tuple[str, str]]:
    papers = root / "papers"
    if not papers.is_dir():
        return []
    found: list[tuple[str, str]] = []
    for path in sorted(papers.glob("*.pdf"))[:MAX_PDFS]:
        try:
            found.append((path.name, vote(text_of(path))))
        except OSError:
            found.append((path.name, "看不清"))
    return found


def chosen_line(text: str) -> str:
    match = CHOSEN.search(text)
    return match.group(1).strip() if match else ""


def render_report(rows: list[tuple[str, str]], previous: str) -> str:
    counts = {"编号": 0, "作者-年": 0, "看不清": 0}
    for _, kind in rows:
        counts[kind] = counts.get(kind, 0) + 1
    order = [name for name, _ in sorted(
        (("编号", counts["编号"]), ("作者-年", counts["作者-年"])),
        key=lambda item: (-item[1], item[0]),
    )]
    lines = [
        "# 引用样式",
        "",
        f"- 已看 PDF：{len(rows)}",
        f"- 编号：{counts['编号']}",
        f"- 作者-年：{counts['作者-年']}",
        f"- 看不清：{counts['看不清']}",
        "",
        "## 推荐",
        "按这些 PDF 里实际的引用样子排序。没有默认项。",
        "",
    ]
    for index, name in enumerate(order, 1):
        note = "项目 PDF 里这一类更多。" if counts[name] else "项目 PDF 里没看出来，仍可选用。"
        lines.append(f"{index}. {name}。{note}")
    lines.append(f"{len(order) + 1}. 按期刊。先选定目标期刊，把该刊的 csl 放到 manuscript/journal.csl。")
    lines += ["", "选定：" + chosen_line(previous), ""]
    return "\n".join(lines)


def apply_choice(root: Path, choice: str, skill_dir: Path) -> str:
    dest = root / "manuscript" / "citation.csl"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if choice == "编号":
        source = skill_dir / "ieee.csl"
    elif choice == "作者-年":
        source = skill_dir / "author-date.csl"
    elif choice == "按期刊":
        source = root / "manuscript" / "journal.csl"
        if not source.is_file():
            raise SystemExit("选定了按期刊，但 manuscript/journal.csl 还不存在")
    else:
        raise SystemExit("选定必须是「编号」「作者-年」或「按期刊」")
    if not source.is_file():
        raise SystemExit(f"缺少样式文件 {source}")
    dest.write_bytes(source.read_bytes())
    return "citation.csl"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recommend citation style from project PDFs")
    parser.add_argument("--root", required=True)
    parser.add_argument("--require-choice", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.root)
    out = root / "manuscript" / "citation-style.md"
    previous = out.read_text(encoding="utf-8") if out.is_file() else ""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_report(collect(root), previous), encoding="utf-8")
    choice = chosen_line(out.read_text(encoding="utf-8"))
    if args.require_choice and not choice:
        print("citation style not chosen", file=sys.stderr)
        return 2
    if args.apply:
        if not choice:
            print("citation style not chosen", file=sys.stderr)
            return 2
        name = apply_choice(root, choice, Path(__file__).resolve().parents[1])
        print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
