#!/usr/bin/env python3
"""Markdown [@key] → Word docx with real EndNote ADDIN EN.CITE fields.

Does not launch EndNote or Word. Unmatched keys fail closed (no docx).
Visible text never contains {Author, Year} temporary citations.
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import struct
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ET.register_namespace("w", W_NS)
ET.register_namespace("wp", WP_NS)
ET.register_namespace("a", A_NS)
ET.register_namespace("pic", PIC_NS)
ET.register_namespace("r", R_NS)
W = "{%s}" % W_NS
# 正文栏大约 6.25 英寸。按像素比例缩进这一宽度，不按 96 dpi 原寸铺开。
MAX_CX = 5_715_000
MAX_CY = 7_315_200

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
# Quarto / 交叉引用花括号。EndNote 会把 {#键} 当成临时引文去库里搜。
CURLY_KEY = re.compile(r"\{#(?!fig-|tbl-)([A-Za-z0-9_.:-]+)\}")


def load_library_match():
    path = Path(__file__).with_name("library_match.py")
    spec = importlib.util.spec_from_file_location("library_match", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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
    # 只有库里 DOI 唯一时才写记录号和外键。没指定库、库锁住、或同一 DOI 多条时不写，
    # 不编 db-id="mesa" 和 1…n 的顺序号，刷新只靠域里的题录。
    library_num = rec.get("_en_rec")
    db_id = rec.get("_en_db") if isinstance(library_num, int) else ""
    shown_num = library_num if isinstance(library_num, int) else 0
    foreign = ""
    if isinstance(library_num, int) and isinstance(db_id, str) and db_id and db_id != "mesa":
        foreign = (
            f'<foreign-keys><key app="EN" db-id="{xml_escape(db_id)}" timestamp="0">'
            f"{library_num}</key></foreign-keys>"
        )
    return (
        f"<record><rec-number>{shown_num}</rec-number><label>{label}</label>"
        f"{foreign}"
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
        num = rec.get("_en_rec") if isinstance(rec.get("_en_rec"), int) else 0
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


def run_text(text: str, vertical: str | None = None, bold: bool = False, italic: bool = False) -> ET.Element:
    r = w_el("r")
    if vertical or bold or italic:
        props = w_el("rPr")
        if bold:
            props.append(w_el("b"))
        if italic:
            props.append(w_el("i"))
        if vertical in {"superscript", "subscript"}:
            props.append(w_el("vertAlign", **{"val": vertical}))
        r.append(props)
    t = w_el("t", text)
    if text[:1] in " \t" or text[-1:] in " \t":
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    r.append(t)
    return r


# Pandoc 单位：cm^−3^、kg^−1^。两端的 ^ 收成上标或下标，不再把记号留在正文里。
MARK_RE = re.compile(r"(\*\*[^*]+\*\*|\*[^*]+\*|\^[^^]+\^|~[^~]+~)")


def append_marked(p: ET.Element, text: str) -> None:
    pos = 0
    for match in MARK_RE.finditer(text):
        if match.start() > pos:
            p.append(run_text(text[pos:match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            p.append(run_text(token[2:-2], bold=True))
        elif token.startswith("*"):
            p.append(run_text(token[1:-1], italic=True))
        elif token.startswith("^"):
            p.append(run_text(token[1:-1], vertical="superscript"))
        else:
            p.append(run_text(token[1:-1], vertical="subscript"))
        pos = match.end()
    if pos < len(text):
        p.append(run_text(text[pos:]))


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


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """稿头的标题、摘要、关键词。以前整段丢掉，Word 里就没有这三项。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    raw = text[3:end]
    rest = text[end + 4 :]
    if rest.startswith("\n"):
        rest = rest[1:]
    fields: dict[str, str] = {}
    current = ""
    mode = ""
    for line in raw.splitlines():
        if mode == "block":
            if line.startswith("  ") or line.startswith("\t"):
                fields[current] = (fields.get(current, "") + " " + line.strip()).strip()
                continue
            mode = ""
        if mode == "list":
            item = re.match(r"^\s*-\s+(.*)$", line)
            if item:
                fields[current] = (fields.get(current, "") + "; " + item.group(1).strip()).strip("; ")
                continue
            mode = ""
        head = re.match(r"^([A-Za-z][\w-]*):\s*(.*)$", line)
        if not head:
            continue
        current = head.group(1)
        value = head.group(2).strip().strip('"')
        if value in {"|", ">", "|-"}:
            mode = "block"
            fields[current] = ""
        elif value == "":
            mode = "list"
            fields[current] = ""
        else:
            fields[current] = value
    return fields, rest


def strip_frontmatter(text: str) -> str:
    return front_matter(text)[1]


def split_blocks(text: str) -> list[tuple[str, str]]:
    fields, body = front_matter(text)
    lines = body.splitlines()
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
        if re.match(r"^---\s*$|^-\s*-\s*-\s*$|^\*\*\*\s*$", line):
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            blocks.append(("hr", ""))
            i += 1
            continue
        if line.lstrip().startswith("|") and "|" in line[1:]:
            if buf:
                blocks.append(("p", "\n".join(buf)))
                buf = []
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(lines[i])
                i += 1
            blocks.append(("table", "\n".join(rows)))
            if i < len(lines) and not lines[i].strip():
                i += 1
            if i < len(lines) and re.match(r"^:\s", lines[i]):
                blocks.append(("tablecap", re.sub(r"^:\s+", "", lines[i]).strip()))
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
    sample = " ".join([fields.get("title", ""), fields.get("abstract", ""), body[:2000]])
    chinese = len(re.findall(r"[\u4e00-\u9fff]", sample)) > len(re.findall(r"[A-Za-z]", sample)) * 0.2
    labels = ("摘要", "关键词", "图", "表") if chinese else ("Abstract", "Keywords", "Figure", "Table")
    head: list[tuple[str, str]] = []
    if fields.get("title"):
        head.append(("title", fields["title"]))
    if fields.get("abstract"):
        head.append(("label", labels[0]))
        head.append(("p", fields["abstract"]))
    if fields.get("keywords"):
        head.append(("label", labels[1]))
        head.append(("p", fields["keywords"]))
    return [("lang", f"{labels[2]}\t{labels[3]}")] + head + blocks


def crossref_maps(blocks: list[tuple[str, str]]) -> tuple[dict[str, int], dict[str, int]]:
    figures: dict[str, int] = {}
    tables: dict[str, int] = {}
    figure_no = 0
    table_no = 0
    for index, (kind, content) in enumerate(blocks):
        if kind == "p":
            for ident in re.findall(r"\{#(fig-[^}]+)\}", content):
                figure_no += 1
                figures.setdefault(ident, figure_no)
        elif kind == "table":
            table_no += 1
            caption = next((text for name, text in blocks[index + 1 :] if name == "tablecap"), "")
            for ident in re.findall(r"\{#(tbl-[^}]+)\}", caption):
                tables.setdefault(ident, table_no)
    return figures, tables


def resolve_crossrefs(text: str, figures: dict[str, int], tables: dict[str, int], figure_word: str, table_word: str) -> str:
    """Figure @fig-1、Table @tbl-1 换成编号。对不上编号的只留名字，不留 @ 和花括号。"""

    def fig(ident: str) -> str:
        return f"{figure_word} {figures[ident]}" if ident in figures else ident

    def tbl(ident: str) -> str:
        return f"{table_word} {tables[ident]}" if ident in tables else ident

    ident = r"[A-Za-z0-9_-]+"
    text = re.sub(rf"\bFigure\s+@(fig-{ident})", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"\bTable\s+@(tbl-{ident})", lambda m: tbl(m.group(1)), text)
    text = re.sub(rf"(?<=图)\s*@(fig-{ident})", lambda m: f" {figures[m.group(1)]}" if m.group(1) in figures else m.group(1), text)
    text = re.sub(rf"(?<=表)\s*@(tbl-{ident})", lambda m: f" {tables[m.group(1)]}" if m.group(1) in tables else m.group(1), text)
    text = re.sub(rf"@(fig-{ident})", lambda m: fig(m.group(1)), text)
    text = re.sub(rf"@(tbl-{ident})", lambda m: tbl(m.group(1)), text)
    text = re.sub(r"\{#(fig-[^}]+)\}", lambda m: fig(m.group(1)), text)
    text = re.sub(r"\{#(tbl-[^}]+)\}", lambda m: tbl(m.group(1)), text)
    return text.strip()


def brace_keys(text: str) -> list[tuple[int, int, str]]:
    """{#键} 里能在 bib 对上的，换成引用域。对不上的只去掉花括号，不留给 EndNote 搜索。"""
    out = []
    for match in CURLY_KEY.finditer(text):
        out.append((match.start(), match.end(), match.group(1)))
    return out


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
    spans = [(m.start(), m.end(), "cite", m.group(1)) for m in CITE_RE.finditer(text)]
    spans.extend((start, end, "brace", key) for start, end, key in brace_keys(text))
    spans.sort(key=lambda item: item[0])
    for start, end, kind, payload in spans:
        if start < pos:
            continue
        if start > pos:
            append_marked(p, text[pos:start])
        if kind == "brace":
            rec = bib.get(payload)
            if rec is None:
                append_marked(p, payload)
            else:
                cited.append(payload)
                display = display_for([rec])
                p.extend(field_runs(cite_instruction([rec], rec_nums, display), display))
            pos = end
            continue
        match_keys = payload
        keys = parse_cite_keys(match_keys)
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
            append_marked(p, text[start:end])
        pos = end
    if pos < len(text):
        append_marked(p, text[pos:])


def visible_text(root: ET.Element) -> str:
    return "".join(el.text or "" for el in root.iter(W + "t"))


def image_spans(text: str) -> list[tuple[int, int, str, str]]:
    """Markdown 图片。说明里的 `[@键]` 含 `]`，只把 `](` 当作图片结束。"""
    found = []
    i = 0
    while True:
        start = text.find("![", i)
        if start < 0:
            break
        close = text.find("](", start + 2)
        end_paren = text.find(")", close + 2) if close >= 0 else -1
        if close < 0 or end_paren < 0:
            break
        alt = text[start + 2 : close]
        target = text[close + 2 : end_paren].strip().split()[0].strip("<>")
        end = end_paren + 1
        if end < len(text) and text[end] == "{":
            attr = text.find("}", end)
            if attr >= 0:
                end = attr + 1
        found.append((start, end, alt, target))
        i = end
    return found


def image_size(path: Path, data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        width, height = struct.unpack(">II", data[16:24])
        return (width, height) if width and height else None
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                height, width = struct.unpack(">HH", data[i + 5 : i + 9])
                return (width, height) if width and height else None
            if marker == 0xD8 or marker == 0xD9:
                i += 2
                continue
            if i + 4 > len(data):
                break
            i += 2 + struct.unpack(">H", data[i + 2 : i + 4])[0]
    if data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 10:
        width, height = struct.unpack("<HH", data[6:10])
        return (width, height) if width and height else None
    return None


def fit_emu(width: int, height: int) -> tuple[int, int]:
    cx = MAX_CX
    cy = max(1, int(cx * height / width))
    if cy > MAX_CY:
        cy = MAX_CY
        cx = max(1, int(cy * width / height))
    return cx, cy


def drawing_run(rel_id: str, name: str, doc_id: int, cx: int, cy: int) -> ET.Element:
    run = w_el("r")
    drawing = ET.SubElement(run, W + "drawing")
    inline = ET.SubElement(drawing, f"{{{WP_NS}}}inline")
    inline.set("distT", "0")
    inline.set("distB", "0")
    inline.set("distL", "0")
    inline.set("distR", "0")
    ET.SubElement(inline, f"{{{WP_NS}}}extent", {"cx": str(cx), "cy": str(cy)})
    ET.SubElement(inline, f"{{{WP_NS}}}effectExtent", {"l": "0", "t": "0", "r": "0", "b": "0"})
    ET.SubElement(inline, f"{{{WP_NS}}}docPr", {"id": str(doc_id), "name": name})
    graphic = ET.SubElement(
        ET.SubElement(inline, f"{{{A_NS}}}graphic"),
        f"{{{A_NS}}}graphicData",
        {"uri": PIC_NS},
    )
    pic = ET.SubElement(graphic, f"{{{PIC_NS}}}pic")
    nv = ET.SubElement(pic, f"{{{PIC_NS}}}nvPicPr")
    ET.SubElement(nv, f"{{{PIC_NS}}}cNvPr", {"id": str(doc_id), "name": name})
    ET.SubElement(nv, f"{{{PIC_NS}}}cNvPicPr")
    blip_fill = ET.SubElement(pic, f"{{{PIC_NS}}}blipFill")
    ET.SubElement(blip_fill, f"{{{A_NS}}}blip").set(f"{{{R_NS}}}embed", rel_id)
    ET.SubElement(ET.SubElement(blip_fill, f"{{{A_NS}}}stretch"), f"{{{A_NS}}}fillRect")
    sp = ET.SubElement(pic, f"{{{PIC_NS}}}spPr")
    xfrm = ET.SubElement(sp, f"{{{A_NS}}}xfrm")
    ET.SubElement(xfrm, f"{{{A_NS}}}off", {"x": "0", "y": "0"})
    ET.SubElement(xfrm, f"{{{A_NS}}}ext", {"cx": str(cx), "cy": str(cy)})
    ET.SubElement(ET.SubElement(sp, f"{{{A_NS}}}prstGeom", {"prst": "rect"}), f"{{{A_NS}}}avLst")
    return run


def resolve_image(source_dir: Path, target: str) -> Path | None:
    if not target or "://" in target:
        return None
    path = Path(target)
    if not path.is_absolute():
        path = source_dir / path
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if path.is_file() else None


def table_rows(text: str) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        rows.append(cells)
    return rows


def append_table(
    body: ET.Element,
    text: str,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
) -> None:
    rows = table_rows(text)
    if not rows:
        return
    width = 9360
    cols = max(len(row) for row in rows)
    table = w_el("tbl")
    props = w_el("tblPr")
    props.append(w_el("tblW", **{"w": str(width), "type": "dxa"}))
    props.append(w_el("tblBorders"))
    borders = props[-1]
    borders.append(w_el("top", **{"val": "single", "sz": "12", "space": "0", "color": "000000"}))
    borders.append(w_el("bottom", **{"val": "single", "sz": "12", "space": "0", "color": "000000"}))
    for edge in ("left", "right", "insideH", "insideV"):
        borders.append(w_el(edge, **{"val": "nil"}))
    table.append(props)
    grid = w_el("tblGrid")
    col_w = str(width // cols)
    for _ in range(cols):
        grid.append(w_el("gridCol", **{"w": col_w}))
    table.append(grid)
    for index, row in enumerate(rows):
        tr = w_el("tr")
        if index == 0:
            tr.append(w_el("trPr"))
            tr[0].append(w_el("tblHeader"))
        for cell in row:
            tc = w_el("tc")
            tc_props = w_el("tcPr")
            tc_props.append(w_el("tcW", **{"w": col_w, "type": "dxa"}))
            if index == 0:
                cell_borders = w_el("tcBorders")
                cell_borders.append(w_el("bottom", **{"val": "single", "sz": "6", "space": "0", "color": "000000"}))
                tc_props.append(cell_borders)
            tc.append(tc_props)
            p = w_el("p")
            append_inline(p, cell, bib, rec_nums, cited, missing, False)
            if index == 0:
                for run in list(p):
                    if run.find(W + "t") is None:
                        continue
                    props = run.find(W + "rPr")
                    if props is None:
                        props = w_el("rPr")
                        run.insert(0, props)
                    props.append(w_el("b"))
            tc.append(p)
            tr.append(tc)
        table.append(tr)
    body.append(table)


def append_content(
    body: ET.Element,
    text: str,
    source_dir: Path,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
    images: list[dict],
    missing_images: list[str],
):
    spans = image_spans(text)
    if not spans:
        p = w_el("p")
        append_inline(p, text.replace("\n", " "), bib, rec_nums, cited, missing, False)
        body.append(p)
        return
    cursor = 0
    for start, end, alt, target in spans:
        before = text[cursor:start].strip()
        if before:
            p = w_el("p")
            append_inline(p, before.replace("\n", " "), bib, rec_nums, cited, missing, False)
            body.append(p)
        path = resolve_image(source_dir, target)
        data = path.read_bytes() if path else b""
        size = image_size(path, data) if path else None
        if path is None or size is None:
            missing_images.append(target)
            p = w_el("p")
            p.append(run_text(f"[缺图 {target}]"))
            body.append(p)
        else:
            rel_id = f"rIdImg{len(images) + 1}"
            suffix = path.suffix.lower() or ".png"
            name = f"image{len(images) + 1}{suffix}"
            cx, cy = fit_emu(*size)
            images.append(
                {
                    "id": rel_id,
                    "name": name,
                    "data": data,
                    "suffix": suffix.lstrip("."),
                }
            )
            p = w_el("p")
            p.append(drawing_run(rel_id, name, len(images), cx, cy))
            body.append(p)
            caption = alt.replace("**", "").strip()
            if caption:
                cap = w_el("p")
                append_inline(cap, caption, bib, rec_nums, cited, missing, False)
                body.append(cap)
        cursor = end
    after = text[cursor:].strip()
    if after:
        p = w_el("p")
        append_inline(p, after.replace("\n", " "), bib, rec_nums, cited, missing, False)
        body.append(p)


def build_body(
    blocks: list[tuple[str, str]],
    source_dir: Path,
    bib: dict[str, dict],
    rec_nums: dict[str, int],
    cited: list[str],
    missing: list[str],
) -> tuple[ET.Element, list[dict], list[str]]:
    body = w_el("body")
    images: list[dict] = []
    missing_images: list[str] = []
    numbers = [0, 0, 0, 0, 0, 0]
    figure_no = 0
    table_no = 0
    figure_word = "Figure"
    table_word = "Table"
    figures, tables = crossref_maps(blocks)
    for kind, content in blocks:
        if kind == "lang":
            words = (content or "").split("\t")
            figure_word = words[0] or figure_word
            table_word = words[1] if len(words) > 1 and words[1] else table_word
            continue
        content = resolve_crossrefs(content, figures, tables, figure_word, table_word)
        if kind == "code":
            p = w_el("p")
            p.append(run_text(content))
            body.append(p)
            continue
        if kind == "hr":
            p = w_el("p")
            props = w_el("pPr")
            border = w_el("pBdr")
            border.append(w_el("bottom", **{"val": "single", "sz": "6", "space": "1", "color": "888888"}))
            props.append(border)
            p.append(props)
            body.append(p)
            continue
        if kind == "table":
            table_no += 1
            append_table(body, content, bib, rec_nums, cited, missing)
            continue
        if kind == "tablecap":
            cap = w_el("p")
            props = w_el("pPr")
            props.append(w_el("jc", **{"val": "center"}))
            cap.append(props)
            append_inline(cap, f"{table_word} {table_no}. {content}", bib, rec_nums, cited, missing, False)
            body.append(cap)
            continue
        if kind == "title":
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": "Title"}))
            props.append(w_el("jc", **{"val": "center"}))
            p.append(props)
            append_inline(p, content, bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        if kind == "label":
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": "Heading1"}))
            p.append(props)
            append_inline(p, content, bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        if kind.startswith("h") and kind[1:].isdigit():
            level = int(kind[1:])
            numbers[level - 1] += 1
            for deeper in range(level, 6):
                numbers[deeper] = 0
            prefix = ".".join(str(n) for n in numbers[:level] if n)
            p = w_el("p")
            props = w_el("pPr")
            props.append(w_el("pStyle", **{"val": f"Heading{level}"}))
            p.append(props)
            append_inline(p, f"{prefix} {content}", bib, rec_nums, cited, missing, True)
            body.append(p)
            continue
        before = len(images)
        append_content(
            body,
            content,
            source_dir,
            bib,
            rec_nums,
            cited,
            missing,
            images,
            missing_images,
        )
        added = len(images) - before
        if added:
            figure_no += 1
            label = w_el("p")
            props = w_el("pPr")
            props.append(w_el("jc", **{"val": "center"}))
            label.append(props)
            label.append(run_text(f"{figure_word} {figure_no}", bold=True))
            # 插在这张图的段落之前。图注仍跟在图后，引用域不被改写。
            body.insert(len(list(body)) - added * 2, label)
    section = w_el("sectPr")
    section.append(w_el("pgSz", **{"w": "11906", "h": "16838"}))
    section.append(w_el("pgMar", **{
        "top": "1440", "right": "1440", "bottom": "1440", "left": "1440",
        "header": "720", "footer": "720", "gutter": "0",
    }))
    footer_ref = w_el("footerReference", **{"type": "default"})
    footer_ref.set(f"{{{R_NS}}}id", "rIdFooter")
    section.append(footer_ref)
    body.append(section)
    return body, images, missing_images


def write_docx(path: Path, body: ET.Element, images: list[dict] | None = None):
    images = images or []
    document = ET.Element(W + "document")
    document.append(body)
    xml = ET.tostring(document, encoding="utf-8", xml_declaration=True)
    image_types = {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
    }
    defaults = [
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
    ]
    for suffix in sorted({img["suffix"] for img in images}):
        kind = image_types.get(suffix)
        if kind:
            defaults.append(f'<Default Extension="{suffix}" ContentType="{kind}"/>')
    ctypes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        + "\n".join(defaults)
        + '\n<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '\n<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        + '\n<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>\n</Types>\n'
    )
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""
    styles = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>
<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Songti SC"/>
<w:sz w:val="24"/></w:rPr><w:pPr><w:jc w:val="both"/><w:ind w:firstLineChars="200" w:firstLine="480"/>
<w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:jc w:val="left"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="200" w:after="60"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>
</w:styles>
"""
    image_rels = "".join(
        f'<Relationship Id="{img["id"]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{img["name"]}"/>'
        for img in images
    )
    doc_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        + image_rels
        + "</Relationships>\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ctypes)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/_rels/document.xml.rels", doc_rels)
        footer = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'
        )
        zf.writestr("word/footer1.xml", footer)
        zf.writestr("word/styles.xml", styles)
        zf.writestr("word/document.xml", xml)
        for img in images:
            zf.writestr(f"word/media/{img['name']}", img["data"])
    tmp.replace(path)


def write_report(path: Path, payload: dict):
    lines = [
        "# EndNote 域稿报告",
        "",
        f"- 源稿：`{payload['source']}`",
        f"- 引用处：{payload['spans']}",
        f"- 唯一键：{payload['unique']}",
        f"- 未匹配：{len(payload['missing'])}",
        f"- 插图：{payload.get('images', 0)}",
        f"- 缺图：{len(payload.get('missing_images') or [])}",
    ]
    if payload["missing"]:
        lines.append("")
        lines.append("未匹配键（未写 docx）：")
        for key in payload["missing"]:
            lines.append(f"- `{key}`")
        lines.append("")
        lines.append("补齐 references.bib 后重跑，不要把这份稿当 EndNote 可换样式。")
    if payload.get("missing_images"):
        lines.append("")
        lines.append("正文插图找不到或读不出尺寸（未写 docx）：")
        for target in payload["missing_images"]:
            lines.append(f"- `{target}`")
    else:
        lines.append("")
        lines.append("打开 `output/endnote.docx`，在 EndNote 工具栏点 Update Citations and Bibliography，再换 Output Style。不要改源稿里的 `[@键]`。")
        lines.append("合意后另存为 `manuscript/source.docx`。不要覆盖这份报告或源稿。")
    binding = payload.get("binding") or []
    if binding:
        lines.append("")
        lines.append("## 库绑定")
        lines.extend(binding)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build EndNote-field docx from Markdown citations")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--endnote-library", default="")
    parser.add_argument("--project-root", default="")
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
        for _start, _end, key in brace_keys(body):
            if key in records and key not in preview_keys:
                preview_keys.append(key)
    for key in preview_keys:
        if key in records:
            rec_nums[key] = len(rec_nums) + 1
    match = load_library_match()
    chosen = Path(args.endnote_library) if args.endnote_library else None
    root = Path(args.project_root) if args.project_root else None
    binding = match.bind_endnote(records, list(rec_nums), chosen, root)
    body_el, images, missing_images = build_body(
        blocks, source.parent, records, rec_nums, cited, missing
    )
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
        "images": len(images),
        "missing_images": missing_images,
        "binding": binding,
    }
    write_report(report, payload)
    if uniq_missing:
        print("unmatched citation keys: " + ", ".join(uniq_missing), file=sys.stderr)
        return 1
    if missing_images:
        print("missing figures: " + ", ".join(missing_images), file=sys.stderr)
        return 1
    visible = visible_text(body_el)
    if CURLY_KEY.search(visible) or CURLY_TEMP.search(visible):
        print("visible text contains {Author, Year}; refusing to write docx", file=sys.stderr)
        return 1
    write_docx(out, body_el, images)
    return 0


if __name__ == "__main__":
    sys.exit(main())
