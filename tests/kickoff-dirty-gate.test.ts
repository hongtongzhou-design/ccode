import assert from "node:assert/strict";
import test from "node:test";
import { dirtyInputHits, inputPathMatches } from "../src/kickoff-dirty-gate.ts";
import type { GitFileDto } from "../src/types.ts";

function f(path: string): GitFileDto {
  return { path, status: "M", additions: null, deletions: null };
}

test("目录输入命中任意深度子文件，同级前缀名不误伤", () => {
  assert.ok(inputPathMatches("notes/", "notes/a.md"));
  assert.ok(inputPathMatches("notes", "notes/sub/deep/b.md"));
  assert.ok(!inputPathMatches("notes", "notes2/a.md"));
  assert.ok(!inputPathMatches("notes", "data/notes.md"));
});

test("文件输入精确命中，不当前缀用", () => {
  assert.ok(inputPathMatches("references.bib", "references.bib"));
  assert.ok(!inputPathMatches("papers/included.md", "papers/included.md.bak"));
  assert.ok(!inputPathMatches("papers/included.md", "papers/included.json"));
});

test("单层 glob 只收目录直接子文件并按扩展名", () => {
  assert.ok(inputPathMatches("papers/*.pdf", "papers/Smith-2020-x.pdf"));
  assert.ok(!inputPathMatches("papers/*.pdf", "papers/imports/a.pdf"));
  assert.ok(!inputPathMatches("papers/*.pdf", "papers/Smith-2020-x.docx"));
  assert.ok(inputPathMatches("*.pdf", "top.pdf"));
  assert.ok(!inputPathMatches("*.pdf", "nested/top.pdf"));
});

test("反斜杠与 . 前缀归一后再比", () => {
  assert.ok(inputPathMatches("notes\\", "notes\\a.md"));
  assert.ok(inputPathMatches("./notes/", "notes/a.md"));
});

test("dirtyInputHits 按本步输入并集过滤并保序", () => {
  const files = [
    f("notes/01-a.md"),
    f("papers/screening.md"), // 改了但不属于本步输入：不进软门
    f("references.bib"),
    f("papers/included.json"),
    f("notes/glossary.md"),
  ];
  const hits = dirtyInputHits(files, [
    "notes/",
    "references.bib",
    "papers/included.json",
  ]);
  assert.deepEqual(
    hits.map((x) => x.path),
    ["notes/01-a.md", "references.bib", "papers/included.json", "notes/glossary.md"],
  );
  assert.deepEqual(dirtyInputHits(files, []), []);
});
