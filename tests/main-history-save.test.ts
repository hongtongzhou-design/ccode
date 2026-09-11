import assert from "node:assert/strict";
import test from "node:test";
import {
  historySaveBlockedReason,
  historySaveMessage,
  historySavePaths,
} from "../src/main-history-save.ts";
import type { GitFileDto } from "../src/types.ts";

function file(path: string, status: string): GitFileDto {
  return { path, status, additions: null, deletions: null };
}

test("blocked when empty, merging, or conflicted", () => {
  assert.equal(historySaveBlockedReason([]), "没有可存入历史的改动");
  assert.equal(
    historySaveBlockedReason([file("a.md", "M")], true),
    "正在合并，请打开改动处理后再存",
  );
  assert.equal(
    historySaveBlockedReason([file("a.md", "U")]),
    "有冲突文件，请打开改动处理后再存",
  );
  assert.equal(historySaveBlockedReason([file("notes/a.md", "??")]), null);
});

test("message uses step name, not chore prefix", () => {
  assert.equal(
    historySaveMessage("文献检索与筛选", [file("notes/a.md", "M")]),
    "文献检索与筛选",
  );
  assert.equal(
    historySaveMessage("文献检索与筛选", [
      file("notes/a.md", "M"),
      file("papers/included.md", "??"),
    ]),
    "文献检索与筛选（2 处）",
  );
  assert.equal(historySaveMessage("", [file("notes/a.md", "M")]), "notes/a.md");
  assert.doesNotMatch(
    historySaveMessage("文献检索与筛选", [file("a.md", "M")]),
    /chore:/,
  );
});

test("paths keep git_status order and drop blanks", () => {
  assert.deepEqual(
    historySavePaths([file("notes/a.md", "M"), file("  ", "??"), file("b.md", "A")]),
    ["notes/a.md", "b.md"],
  );
});
