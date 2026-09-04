import assert from "node:assert/strict";
import test from "node:test";
import {
  groupFilesByStatus,
  statusBadgeTitle,
  statusGroupKey,
} from "../src/git-status-groups.ts";
import type { GitFileDto } from "../src/types.ts";

function file(path: string, status: string): GitFileDto {
  return { path, status, additions: null, deletions: null };
}

test("状态分组：A/?? 进新增，D 进删除，M/R 与未知状态兜底进修改", () => {
  assert.equal(statusGroupKey("M"), "modified");
  assert.equal(statusGroupKey("R"), "modified");
  assert.equal(statusGroupKey("A"), "added");
  assert.equal(statusGroupKey("??"), "added");
  assert.equal(statusGroupKey("D"), "deleted");
  assert.equal(statusGroupKey("U"), "unmerged");
  assert.equal(statusGroupKey("UU"), "unmerged");
});

test("状态分组：组序固定为 冲突 → 修改 → 新增 → 删除，组内保持原顺序，空组省略", () => {
  const groups = groupFilesByStatus([
    file("new.ts", "??"),
    file("a.ts", "M"),
    file("gone.ts", "D"),
    file("b.ts", "M"),
    file("staged.ts", "A"),
    file("hit.ts", "U"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.files.map((f) => f.path)]),
    [
      ["冲突的", ["hit.ts"]],
      ["修改的", ["a.ts", "b.ts"]],
      ["新增的", ["new.ts", "staged.ts"]],
      ["删除的", ["gone.ts"]],
    ],
  );
  assert.deepEqual(groupFilesByStatus([]), []);
});

test("徽标悬浮 title：字母保留 + 白话说明", () => {
  assert.equal(statusBadgeTitle("M"), "M · 已修改");
  assert.equal(statusBadgeTitle("??"), "?? · 新文件");
  assert.equal(statusBadgeTitle("UU"), "UU · 未合并（冲突）");
  assert.equal(statusBadgeTitle("U"), "U · 未合并（冲突）");
});
