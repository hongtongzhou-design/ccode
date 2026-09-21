import assert from "node:assert/strict";
import test from "node:test";
import {
  scanWritingReview,
  sortWritingPreviewPaths,
  writingReturnPrompt,
  writingScanSourcePath,
} from "../src/draft-review.ts";

test("扫描：摘要待核实、G 编号、待绘制、手写序号", () => {
  const text = `## Abstract
Hello [待核实] world

## 1. Introduction
The gap (G1) remains.
**Figure 1 (待绘制).**
`;
  const hits = scanWritingReview(text);
  assert.deepEqual(
    hits.map((h) => h.id),
    ["abstract-unverified", "gap-ids", "placeholder-fig", "manual-numbers"],
  );
});

test("大纲框架推演里的 G1 不算正文泄漏", () => {
  const text = `## 1. 引言
卖点。

## 框架推演
- G1［方法］：机理未统一
`;
  assert.equal(
    scanWritingReview(text, { allowGapIds: true }).some((h) => h.id === "gap-ids"),
    false,
  );
});

test("稿件页：源稿优先，Word 先于 PDF", () => {
  assert.deepEqual(
    sortWritingPreviewPaths([
      "output/draft.pdf",
      "manuscript/draft.md",
      "output/draft.docx",
    ]),
    ["manuscript/draft.md", "output/draft.docx", "output/draft.pdf"],
  );
  assert.equal(
    writingScanSourcePath(["output/draft.pdf", "manuscript/draft.md", ".ccode/a.md"]),
    "manuscript/draft.md",
  );
});

test("退回提示词带上意见和红线", () => {
  const prompt = writingReturnPrompt({
    notes: "删 G1，不要凑字数。",
    hits: [{ id: "gap-ids", label: "正文含空白编号（G1…）" }],
    rewrite: false,
  });
  assert.match(prompt, /不要整篇从零重写/);
  assert.match(prompt, /删 G1/);
  assert.match(prompt, /空白编号/);
  assert.match(writingReturnPrompt({ notes: "", hits: [], rewrite: true }), /重写本步稿件/);
});
