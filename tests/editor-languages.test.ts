import assert from "node:assert/strict";
import test from "node:test";
import {
  LATEX_EXTENSIONS,
  LATEX_LANGUAGE_ID,
  latexMonarch,
  matchLanguageByPath,
} from "../src/editor-languages.ts";

test("latex 语言注册覆盖 .tex/.sty/.cls/.bib", () => {
  assert.deepEqual(LATEX_EXTENSIONS, [".tex", ".sty", ".cls", ".bib"]);
  const langs = [{ id: LATEX_LANGUAGE_ID, extensions: [...LATEX_EXTENSIONS] }];
  assert.equal(matchLanguageByPath(langs, "manuscript/main.tex"), "latex");
  assert.equal(matchLanguageByPath(langs, "C:\\proj\\styles\\book.cls"), "latex");
  assert.equal(matchLanguageByPath(langs, "refs.bib"), "latex");
  assert.equal(matchLanguageByPath(langs, "notes.md"), undefined);
  assert.equal(matchLanguageByPath(langs, "Makefile"), undefined);
});

test("文件名精确匹配优先于扩展名", () => {
  const langs = [
    { id: "dockerfile", filenames: ["Dockerfile"] },
    { id: "latex", extensions: [".tex"] },
  ];
  assert.equal(matchLanguageByPath(langs, "/app/Dockerfile"), "dockerfile");
});

test("扩展名大小写不敏感", () => {
  const langs = [{ id: "latex", extensions: [".tex"] }];
  assert.equal(matchLanguageByPath(langs, "MAIN.TEX"), "latex");
});

test("latex monarch 定义：注释/命令/公式状态齐备", () => {
  const rules = latexMonarch.tokenizer.root as unknown[];
  assert.ok(
    rules.some((r) => Array.isArray(r) && r[1] === "comment"),
    "要有 % 注释规则",
  );
  assert.ok(latexMonarch.tokenizer.mathInline, "要有行内公式状态");
  assert.ok(latexMonarch.tokenizer.mathDisplay, "要有块级公式状态");
});
