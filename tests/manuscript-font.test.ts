import assert from "node:assert/strict";
import test from "node:test";
import { manuscriptFontPrompt } from "../src/manuscript-font.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
const zipXml = (docx: string) =>
  spawnSync(
    python,
    ["-c", "import sys; sys.stdout.reconfigure(encoding='utf-8'); import zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.read('word/styles.xml').decode())", docx],
    { encoding: "utf8" },
  );

const script = resolve("src-tauri/resources/skills/quarto-render/scripts/manuscript_font.py");

test("确认字体的提示同时改 PDF 和 Word", () => {
  const ask = manuscriptFontPrompt("manuscript/draft.md", "Times New Roman", "宋体");
  assert.match(ask, /Times New Roman/);
  assert.match(ask, /宋体/);
  assert.match(ask, /reference-doc manuscript\/reference\.docx/);
  assert.match(ask, /manuscript_font\.py/);
  assert.match(ask, /不要先渲完再重渲/);
  assert.doesNotMatch(ask, /然后重渲/);
});

test("初稿字体写入 YAML：英文新罗马，中文宋体", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-font-"));
  try {
    mkdirSync(join(root, "manuscript"));
    const md = join(root, "manuscript/draft.md");
    writeFileSync(
      md,
      "---\ntitle: Draft\nformat:\n  pdf:\n    pdf-engine: xelatex\n    mainfont: \"TeX Gyre Termes\"\n---\n\n正文。\n",
    );
    const result = spawnSync(
      python,
      [script, "--root", root, "--markdown", "manuscript/draft.md", "--latin", "Times New Roman", "--cjk", "Songti SC"],
      { encoding: "utf8" },
    );
    if (/本机没有 quarto/.test(result.stderr)) return;
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(md, "utf8");
    assert.match(text, /mainfont: "Times New Roman"/);
    assert.match(text, /CJKmainfont: "Songti SC"/);
    assert.match(text, /booktabs/);
    assert.match(text, /parindent\}\{2em\}/);
    assert.match(readFileSync(join(root, "manuscript/typeface.md"), "utf8"), /英文：Times New Roman/);
    const styles = zipXml(join(root, "manuscript/reference.docx"));
    assert.match(styles.stdout, /Heading1/);
    assert.match(styles.stdout, /outlineLvl w:val="0"/);
    assert.match(styles.stdout, /firstLineChars="200"/);
    assert.match(styles.stdout, /w:line="360"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
