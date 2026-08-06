import assert from "node:assert/strict";
import test from "node:test";
import { defaultCommitMessage } from "../src/git-commit-message.ts";
import type { GitFileDto } from "../src/types.ts";

function file(path: string, status: string): GitFileDto {
  return { path, status, additions: null, deletions: null };
}

test("默认提交信息：单文件按状态区分措辞", () => {
  assert.equal(defaultCommitMessage([file("a.md", "M")]), "chore: 更新 a.md");
  assert.equal(defaultCommitMessage([file("b.md", "??")]), "chore: 添加 b.md");
  assert.equal(defaultCommitMessage([file("c.md", "A")]), "chore: 添加 c.md");
  assert.equal(defaultCommitMessage([file("d.md", "D")]), "chore: 删除 d.md");
  assert.equal(defaultCommitMessage([file("e.md", "R")]), "chore: 重命名 e.md");
});

test("默认提交信息：多文件只报数量，不拼路径", () => {
  assert.equal(
    defaultCommitMessage([file("a.md", "M"), file("b.md", "??")]),
    "chore: 更新 2 个文件",
  );
});
