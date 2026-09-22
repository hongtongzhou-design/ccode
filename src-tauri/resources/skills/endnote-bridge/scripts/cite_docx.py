#!/usr/bin/env python3
"""Markdown [@key] → Word docx with real EndNote ADDIN EN.CITE fields.

Does not launch EndNote or Word. Unmatched keys fail closed (no docx).
Visible text never contains {Author, Year} temporary citations.
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ET.register_namespace("w", W_NS)
W = "{%s}" % W_NS

REF_TYPE = {
    "article": ("Journal Article", "17"),
    "book": ("Book", "6"),
    "incollection": ("Book Section", "5"),
    "inproceedings": ("Conference Proceedings", "10"),
    "phdthesis": ("Thesis", "32"),
    "mastersthesis": ("Thesis", "32"),
    "techreport": ("Report", "27"),
    "misc": ("Generic", "13"),
}

CITE_RE = re.compile(
    r"\[((?:-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)(?:\s*;\s*-?@[A-Za-z0-9_.:-]+(?:\s*,[^\];]*)?)*)\]"
)
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
CURLY_TEMP = re.compile(r"\{[^{}]{1,80},\s*[^{}]{1,20}\}")


def load_bridge():
    path = Path(__file__).with_name("bridge.py")
    spec = importlib.util.spec_from_file_location("endnote_bridge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def xml_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def surname(author: str) -> str:
    name = (author or "").strip()
    if not name:
        return "Anon"
    if "," in name:
        return name.split(",", 1)[0].strip() or "Anon"
    return name.split()[-1]


def display_for(records: list[dict]) -> str:
    parts = []
    for rec in records:
        authors = rec.get("authors") or []
        year = rec.get("year") or "n.d."
        if not authors:
            parts.append(f"{year}")
            continue
        family = surname(authors[0])
        if len(authors) > 1:
            parts.append(f"{family} et al., {year}")
        else:
            parts.append(f"{family}, {year}")
    return "(" + "; ".join(parts) + ")"


def record_xml(rec: dict, rec_num: int) -> str:
    kind, code = REF_TYPE.get(rec.get("type", ""), ("Generic", "13"))
    authors = "".join(
        f"<author>{xml_escape(a)}</author>" for a in (rec.get("authors") or [])
    )
    title = xml_escape(rec.get("title") or "")
    journal = xml_escape(rec.get("journal") or "")
    year = xml_escape(rec.get("year") or "")
    pages = xml_escape(rec.get("pages") or "")
    volume = xml_escape(rec.get("volume") or "")
    number = xml_escape(rec.get("number") or "")
    doi = xml_escape(rec.get("doi") or "")
    url = xml_escape(rec.get("url") or "")
    label = xml_escape(rec.get("id") or "")
    return (
        f"<record><rec-number>{rec_num}</rec-number><label>{label}</label>"
        f'<foreign-keys><key app="EN" db-id="mesa" timestamp="0">{rec_num}</key></foreign-keys>'
        f'<ref-type name="{kind}">{code}</ref-type>'
        f"<contributors><authors>{authors}</authors></contributors>"
        f"<titles><title>{title}</title><secondary-title>{journal}</secondary-title></titles>"
        f"<periodical><full-title>{journal}</full-title></periodical>"
        f"<pages>{pages}</pages><volume>{volume}</volume><number>{number}</number>"
        f"<dates><year>{year}</year></dates>"
        f"<electronic-resource-num>{doi}</electronic-resource-num>"
        f"<urls><related-urls><url>{url}</url></related-urls></urls></record>"
    )


def cite_instruction(group: list[dict], rec_nums: dict[str, int], display: str) -> str:
    cites = []
    for i, rec in enumerate(group):
        num = rec_nums[rec["id"]]
        author = xml_escape(surname((rec.get("authors") or ["Anon"])[0]))
        year = xml_escape(rec.get("year") or "n.d.")
        disp = f"<DisplayText>{xml_escape(display)}</DisplayText>" if i == 0 else ""
        cites.append(
            f"<Cite><Author>{author}</Author><Year>{year}</Year>"
            f"<RecNum>{num}</RecNum>{disp}{record_xml(rec, num)}</Cite>"
        )
    return " ADDIN EN.CITE <EndNote>" + "".join(cites) + "</EndNote>"


def w_el(tag: str, text: str | None = None, **attrs) -> ET.Element:
    el = ET.Element(W + tag)
    for key, value in attrs.items():
        el.set(W + key, value)
    if text is not None:
        el.text = text
    return el


def run_text(text: str) -> ET.Element:
    r = w_el("r")
    t = w_el("t", text)
    if text[:1] in " \t" or text[-1:] in " \t":
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    r.append(t)
    return r


def field_runs(instruction: str, display: str) -> list[ET.Element]:
    begin = w_el("r")
    begin.append(w_el("fldChar", **{"fldCharType": "begin"}))
    instr = w_el("r")
    it = w_el("instrText", instruction)
    it.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    instr.append(it)
    sep = w_el("r")
    sep.append(w_el("fldChar", **{"fldCharType": "separate"}))
    shown = w_el("r")
    shown.append(w_el("t", display))
    end = w_el("r")
    end.append(w_el("fldChar", **{"fldCharType": "end"}))
    return [begin, instr, sep, shown, end]


def parse_cite_keys(span: str) -> list[str]:
    keys = []
    for part in span.split(";"):
        part = part.strip().lstrip("-").lstrip()
        if not part.startswith("@"):
            continue
        key = "".join(
            ch
            for ch in part[1:]
            if ch.isalnum() or ch in "_-.:"
        )
        if key:
            keys.append(key)
    return keys


def strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end >= 0:
            rest = text[end + 4 :]
            return rest[1:] if rest.startswith("\n") else rest
    return text


def split_blocks(text: str) -> list[tuple[str, str]]:
    lines = strip_frontmatter(text).splitlines()
    blocks: list[tuple[str, str]] = []
    buf: list[str] = []
    fence = None
    i = 0
    while i < len(lines):
        line = lines[i]
        open_fence = FENCE_RE.match(line)
        if fence:
            buf.append(line)
            if open_fence and line.strip().startswith(fence):
                blocks.append(("code", "\n".join(buf)))
                buf = []
                fence = None
            i += 1
            continue
        if open_fence:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            fence = open_fence.group(1)[0] * 3
            buf = [line]
            i += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            blocks.append(("h" + str(len(heading.group(1))), heading.group(2).strip()))
            i += 1
            continue
        if not line.strip():
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            i += 1
            continue
        buf.append(line)
        i += 1
    if fence:
        blocks.append(("code", "\n".join(buf)))
    elif buf:
        blocks.append(("p", "\n".join(buf)))
    return blocks


def append_inline(
    p: ET.Element,
    text: str,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
    in_code: bool,
):
    if in_code:
        p.append(run_text(text))
        return
    pos = 0
    for match in CITE_RE.finditer(text):
        if match.start() > pos:
            p.append(run_text(text[pos : match.start()]))
        keys = parse_cite_keys(match.group(1))
        group = []
        for key in keys:
            cited.append(key)
            rec = bib.get(key)
            if rec is None:
                missing.append(key)
            else:
                group.append(rec)
        if group and not any(k not in bib for k in keys):
            display = display_for(group)
            p.extend(field_runs(cite_instruction(group, rec_nums, display), display))
        else:
            p.append(run_text(match.group(0)))
        pos = match.end()
    if pos < len(text):
        p.append(run_text(text[pos:]))


def visible_text(root: ET.Element) -> str:
    return "".join(el.text or "" for el in root.iter(W + "t"))


def write_docx(path: Path, body: ET.Element):
    document = ET.Element(W + "document")
    document.append(body)
    xml = ET.tostring(document, encoding="utf-8", xml_declaration=True)
    ctypes = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""
    doc_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ctypes)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/_rels/document.xml.rels", doc_rels)
        zf.writestr("word/document.xml", xml)
    tmp.replace(path)


def write_report(path: Path, payload: dict):
    lines = [
        "# EndNote 域稿报告",
        "",
        f"- 源稿：`{payload['source']}`",
        f"- 引用处：{payload['spans']}",
        f"- 唯一键：{payload['unique']}",
        f"- 未匹配：{len(payload['missing'])}",
    ]
    if payload["missing"]:
        lines.append("")
        lines.append("未匹配键（未写 docx）：")
        for key in payload["missing"]:
            lines.append(f"- `{key}`")
        lines.append("")
        lines.append("补齐 references.bib 后重跑，不要把这份稿当 EndNote 可换样式。")
    else:
        lines.append("")
        lines.append("打开 `output/endnote.docx`，在 EndNote 工具栏点 Update Citations and Bibliography，再换 Output Style。不要改源稿里的 `[@键]`。")
        lines.append("合意后另存为 `manuscript/source.docx`。不要覆盖这份报告或源稿。")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build EndNote-field docx from Markdown citations")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)
    source = Path(args.input)
    bib_path = Path(args.bib)
    out = Path(args.output)
    report = Path(args.report)
    if out.resolve() == source.resolve() or out.suffix.lower() != ".docx":
        print("output must be a new .docx path", file=sys.stderr)
        return 1
    if not source.is_file() or not bib_path.is_file():
        print("source markdown or bib missing", file=sys.stderr)
        return 1
    bridge = load_bridge()
    records = {rec["id"]: rec for rec in bridge.load(bib_path) if rec.get("id")}
    text = source.read_text(encoding="utf-8-sig")
    blocks = split_blocks(text)
    cited: list[str] = []
    missing: list[str] = []
    # RecNum = first-appearance order among keys that exist in bib
    rec_nums: dict[str, int] = {}
    preview_keys: list[str] = []
    for kind, body in blocks:
        if kind == "code":
            continue
        for match in CITE_RE.finditer(body):
            for key in parse_cite_keys(match.group(1)):
                if key not in preview_keys:
                    preview_keys.append(key)
    for key in preview_keys:
        if key in records:
            rec_nums[key] = len(rec_nums) + 1
    body_el = w_el("body")
    for kind, content in blocks:
        p = w_el("p")
        if kind == "code":
            p.append(run_text(content))
        else:
            append_inline(
                p,
                content.replace("\n", " "),
                records,
                rec_nums,
                cited,
                missing,
                False,
            )
        body_el.append(p)
    reflist = w_el("p")
    reflist.extend(
        field_runs(" ADDIN EN.REFLIST ", " ")
    )
    body_el.append(reflist)
    uniq_missing = sorted(set(missing))
    payload = {
        "source": str(source),
        "spans": len(cited),
        "unique": len(set(cited)),
        "missing": uniq_missing,
    }
    write_report(report, payload)
    if uniq_missing:
        print("unmatched citation keys: " + ", ".join(uniq_missing), file=sys.stderr)
        return 1
    visible = visible_text(body_el)
    if CURLY_TEMP.search(visible):
        print("visible text contains {Author, Year}; refusing to write docx", file=sys.stderr)
        return 1
    write_docx(out, body_el)
    return 0


if __name__ == "__main__":
    sys.exit(main())
