#!/usr/bin/env python3
"""Markdown [@key] → Zotero RTF Scan file plus a RIS of just those items."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

CITE_RE = re.compile(
    r"\[((?:-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)(?:\s*;\s*-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)*)\]"
)
ENTRY_RE = re.compile(r"@\w+\s*\{\s*([^,\s]+)\s*,", re.S)


def parse_keys(span: str) -> list[str]:
    keys = []
    for part in span.split(";"):
        part = part.strip().lstrip("-").strip()
        if not part.startswith("@"):
            continue
        key = "".join(ch for ch in part[1:] if ch.isalnum() or ch in "_-.:")
        if key:
            keys.append(key)
    return keys


def bib_records(text: str) -> dict[str, dict]:
    records = {}
    for match in ENTRY_RE.finditer(text):
        key = match.group(1)
        body = text[match.end():]
        depth = 1
        end = 0
        for i, ch in enumerate(body):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        fields = {}
        for name, value in re.findall(r"(\w+)\s*=\s*[{\"](.*?)[}\"]\s*,?", body[:end], re.S):
            fields[name.lower()] = re.sub(r"\s+", " ", value).strip()
        author = fields.get("author", "")
        family = author.split(" and ")[0].split(",")[0].strip() if author else "Anon"
        records[key] = {
            "family": family or "Anon",
            "year": fields.get("year", "n.d."),
            "title": fields.get("title", ""),
            "author": author,
            "doi": fields.get("doi", ""),
            "journal": fields.get("journal") or fields.get("booktitle", ""),
            "journalabbreviation": fields.get("journalabbreviation", ""),
            "volume": fields.get("volume", ""),
            "number": fields.get("number", ""),
            "pages": fields.get("pages", ""),
            "issn": fields.get("issn", ""),
            "abstract": fields.get("abstract", ""),
            "keywords": fields.get("keywords", ""),
            "date": fields.get("date", ""),
        }
    return records


def rtf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a Zotero RTF Scan manuscript")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--rtf", required=True)
    parser.add_argument("--ris", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)
    markdown = Path(args.input).read_text(encoding="utf-8")
    records = bib_records(Path(args.bib).read_text(encoding="utf-8"))
    missing = []
    pieces = []
    cursor = 0
    used = []
    for match in CITE_RE.finditer(markdown):
        pieces.append(rtf_escape(markdown[cursor:match.start()]))
        keys = parse_keys(match.group(1))
        cites = []
        for key in keys:
            rec = records.get(key)
            if not rec:
                missing.append(key)
                continue
            if key not in used:
                used.append(key)
            cites.append(f"{rec['family']}, {rec['year']}")
        if cites:
            pieces.append("\\{" + "; ".join(cites) + "\\}")
        cursor = match.end()
    pieces.append(rtf_escape(markdown[cursor:]))
    report = Path(args.report)
    report.parent.mkdir(parents=True, exist_ok=True)
    if missing:
        report.write_text("未匹配，未写 Zotero 稿：\n" + "\n".join(missing) + "\n", encoding="utf-8")
        print("unmatched citation keys", file=sys.stderr)
        return 1
    rtf = Path(args.rtf)
    rtf.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(pieces).replace("\n", "\\par\n")
    rtf.write_text("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 " + body + "}", encoding="utf-8")
    ris_lines = []
    for key in used:
        rec = records[key]
        ris_lines.append("TY  - JOUR")
        ris_lines.append(f"ID  - {key}")
        if rec["title"]:
            ris_lines.append(f"TI  - {rec['title']}")
        for author in [part.strip() for part in rec["author"].split(" and ") if part.strip()]:
            ris_lines.append(f"AU  - {author}")
        if rec["year"] and rec["year"] != "n.d.":
            ris_lines.append(f"PY  - {rec['year']}")
        if rec["journal"]:
            ris_lines.append(f"T2  - {rec['journal']}")
        short = rec["journalabbreviation"]
        if short and short.casefold() != rec["journal"].casefold():
            ris_lines.append(f"J2  - {short}")
        if rec["volume"]:
            ris_lines.append(f"VL  - {rec['volume']}")
        if rec["number"]:
            ris_lines.append(f"IS  - {rec['number']}")
        pages = rec["pages"].replace("–", "-").replace("—", "-")
        parts = [part.strip() for part in pages.split("--" if "--" in pages else "-", 1)] if pages else []
        if parts and parts[0]:
            ris_lines.append(f"SP  - {parts[0]}")
        if len(parts) == 2 and parts[1] and parts[1] != parts[0]:
            ris_lines.append(f"EP  - {parts[1]}")
        if rec["date"]:
            ris_lines.append(f"DA  - {rec['date']}")
        if rec["issn"]:
            ris_lines.append(f"SN  - {rec['issn']}")
        if rec["doi"]:
            ris_lines.append(f"DO  - {rec['doi']}")
        for word in [part.strip() for part in rec["keywords"].split(";") if part.strip()]:
            ris_lines.append(f"KW  - {word}")
        if rec["abstract"]:
            ris_lines.append(f"AB  - {rec['abstract']}")
        ris_lines.append("ER  - ")
        ris_lines.append("")
    Path(args.ris).parent.mkdir(parents=True, exist_ok=True)
    Path(args.ris).write_text("\n".join(ris_lines), encoding="utf-8")
    report.write_text(f"已写 {rtf.name}，文献 {len(used)} 条。先导入 RIS，再对 RTF 做一次 RTF Scan。\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
