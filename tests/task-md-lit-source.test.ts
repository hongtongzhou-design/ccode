import assert from "node:assert/strict";
import test from "node:test";
import {
  litSourceSectionLines,
  upsertLitSourceSection,
} from "../src/task-md-sections.ts";

test("search/空：无「文献来源」段", () => {
  assert.equal(litSourceSectionLines("search"), null);
  assert.equal(litSourceSectionLines(""), null);
  assert.equal(litSourceSectionLines(undefined), null);
});

test("zotero/folder：段内容分版本", () => {
  assert.match(litSourceSectionLines("zotero")!.join("\n"), /Zotero 库/);
  assert.match(litSourceSectionLines("folder")!.join("\n"), /本地文件夹/);
});

test("无段时插入：优先落在「已定方向」之前", () => {
  const text = "# 步骤\n\n## 已定方向\n\n- a：b\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "zotero");
  assert.ok(
    out.indexOf("## 文献来源") < out.indexOf("## 已定方向"),
    out,
  );
  assert.ok(out.indexOf("## 已定方向") < out.indexOf("## 预期产物"), out);
});

test("无段且无锚点：补到末尾", () => {
  const text = "# 步骤\n\n简报正文\n";
  const out = upsertLitSourceSection(text, "folder");
  assert.match(out, /简报正文\n\n## 文献来源\n/);
});

test("已有段：原位替换（zotero → folder），不伤前后小节", () => {
  const text =
    "# 步骤\n\n## 文献来源\n\n本项目的文献来自用户已有的 Zotero 库。\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "folder");
  assert.ok(!/Zotero/.test(out), out);
  assert.match(out, /本地文件夹/);
  assert.ok(out.indexOf("## 文献来源") < out.indexOf("## 预期产物"), out);
  assert.equal(out.match(/## 文献来源/g)!.length, 1);
});

test("切回 search：删除该段", () => {
  const text =
    "# 步骤\n\n## 文献来源\n\n本项目的文献来自用户已有的 Zotero 库。\n\n## 预期产物\n\n- x\n";
  const out = upsertLitSourceSection(text, "search");
  assert.ok(!/文献来源/.test(out), out);
  assert.match(out, /## 预期产物/);
});

test("无段 + search：原样返回（调用方据此不写盘）", () => {
  const text = "# 步骤\n\n简报正文\n";
  assert.equal(upsertLitSourceSection(text, "search"), text);
});
