#!/usr/bin/env python3
"""Markdown [@key] → Word docx with real Zotero ADDIN ZOTERO_ITEM fields.

Does not launch Zotero or Word. Unmatched keys fail closed (no docx).
Visible text never contains {Author, Year} temporary citations.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import secrets
import sys
from pathlib import Path

SCHEMA = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"


def load_library_match():
    path = Path(__file__).resolve().parents[2] / "endnote-bridge" / "scripts" / "library_match.py"
    spec = importlib.util.spec_from_file_location("library_match", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_cite():
    path = Path(__file__).resolve().parents[2] / "endnote-bridge" / "scripts" / "cite_docx.py"
    spec = importlib.util.spec_from_file_location("endnote_cite_docx", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_bridge():
    path = Path(__file__).resolve().parents[2] / "endnote-bridge" / "scripts" / "bridge.py"
    spec = importlib.util.spec_from_file_location("endnote_bridge", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def split_name(author: str) -> tuple[str, str]:
    name = (author or "").strip()
    if not name:
        return "", "Anon"
    if "," in name:
        family, given = name.split(",", 1)
        return given.strip(), family.strip() or "Anon"
    parts = name.split()
    if len(parts) == 1:
        return "", parts[0]
    return " ".join(parts[:-1]), parts[-1]


def csl_item(rec: dict, index: int) -> dict:
    names = []
    for author in rec.get("authors") or []:
        given, family = split_name(author)
        item = {"family": family}
        if given:
            item["given"] = given
        names.append(item)
    if not names:
        names = [{"family": "Anon"}]
    item = {
        "id": index,
        "type": "article-journal",
        "title": rec.get("title") or "",
        "author": names,
    }
    if rec.get("year"):
        item["issued"] = {"date-parts": [[str(rec["year"])]]}
    if rec.get("journal"):
        item["container-title"] = rec["journal"]
    if rec.get("volume"):
        item["volume"] = rec["volume"]
    if rec.get("number"):
        item["issue"] = rec["number"]
    if rec.get("pages"):
        item["page"] = rec["pages"]
    if rec.get("doi"):
        item["DOI"] = rec["doi"]
    if rec.get("url"):
        item["URL"] = rec["url"]
    return item


def cite_id() -> str:
    # Zotero.Utilities.randomString 默认 8 位。没有这个 id，刷新会把每条都当成新引用。
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def cite_instruction(group: list[dict], rec_nums: dict[str, int], display: str) -> str:
    items = []
    for rec in group:
        index = rec_nums[rec["id"]]
        # 只有库里 DOI 唯一的那条才写 uris。对不上、库锁住、或同一 DOI 多条时省略，
        # 不编 ITEM-1 这种假地址，否则 Refresh 会当成幽灵条目。
        entry = {"id": index, "itemData": csl_item(rec, index)}
        uri = rec.get("_zotero_uri")
        if isinstance(uri, str) and uri.startswith("http://zotero.org/"):
            entry["uris"] = [uri]
        items.append(entry)
    payload = {
        "citationID": cite_id(),
        "citationItems": items,
        "properties": {
            "formattedCitation": display,
            "plainCitation": display,
            "noteIndex": 0,
        },
        "schema": SCHEMA,
    }
    return " ADDIN ZOTERO_ITEM CSL_CITATION " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + " "


def bibliography_instruction() -> str:
    # 官方域是 BIBL {json} CSL_BIBLIOGRAPHY。预先放在文末，刷新时填内容，不再现场插域。
    payload = {"uncited": [], "omitted": [], "custom": []}
    return (
        " ADDIN ZOTERO_BIBL "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + " CSL_BIBLIOGRAPHY "
    )


def write_report(path: Path, payload: dict):
    lines = [
        "# Zotero 域稿报告",
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
        lines.append("补齐 references.bib 后重跑。")
    if payload.get("missing_images"):
        lines.append("")
        lines.append("正文插图找不到或读不出尺寸（未写 docx）：")
        for target in payload["missing_images"]:
            lines.append(f"- `{target}`")
    else:
        lines.append("")
        lines.append("打开 `output/zotero.docx`，在 Zotero 工具栏点 Refresh，再换引用样式。不要改源稿里的 `[@键]`。")
    binding = payload.get("binding") or []
    if binding:
        lines.append("")
        lines.append("## 库绑定")
        lines.extend(binding)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build Zotero-field docx from Markdown citations")
    parser.add_argument("--input", required=True)
    parser.add_argument("--bib", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--zotero-db", default="")
    args = parser.parse_args(argv)
    cite = load_cite()
    bridge = load_bridge()
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
    records = {rec["id"]: rec for rec in bridge.load(bib_path) if rec.get("id")}
    text = source.read_text(encoding="utf-8-sig")
    blocks = cite.split_blocks(text)
    cited: list[str] = []
    missing: list[str] = []
    rec_nums: dict[str, int] = {}
    preview_keys: list[str] = []
    for kind, body in blocks:
        if kind == "code":
            continue
        for match in cite.CITE_RE.finditer(body):
            for key in cite.parse_cite_keys(match.group(1)):
                if key not in preview_keys:
                    preview_keys.append(key)
        for _start, _end, key in cite.brace_keys(body):
            if key in records and key not in preview_keys:
                preview_keys.append(key)
    for key in preview_keys:
        if key in records:
            rec_nums[key] = len(rec_nums) + 1
    match = load_library_match()
    chosen = Path(args.zotero_db) if args.zotero_db else None
    binding = match.bind_zotero(records, list(rec_nums), chosen)

    def instruction(group, numbers, display):
        return cite_instruction(group, numbers, display)

    cite.cite_instruction = instruction
    body_el, images, missing_images = cite.build_body(
        blocks, source.parent, records, rec_nums, cited, missing
    )
    bibliography = cite.w_el("p")
    bibliography.extend(cite.field_runs(bibliography_instruction(), "参考文献"))
    children = list(body_el)
    insert_at = next((i for i, child in enumerate(children) if child.tag == cite.W + "sectPr"), len(children))
    body_el.insert(insert_at, bibliography)
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
    visible = cite.visible_text(body_el)
    if cite.CURLY_KEY.search(visible) or cite.CURLY_TEMP.search(visible):
        print("visible text contains {Author, Year}; refusing to write docx", file=sys.stderr)
        return 1
    cite.write_docx(out, body_el, images)
    return 0


if __name__ == "__main__":
    sys.exit(main())
