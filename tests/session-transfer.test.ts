import assert from "node:assert/strict";
import test from "node:test";
import {
  canApply,
  cwdDiffersFromProject,
  defaultDecisions,
  importStatusLabel,
  pathBasename,
  suggestTargetDir,
} from "../src/session-transfer.ts";
import type { ImportPreviewEntryDto } from "../src/types.ts";

function e(
  over: Partial<ImportPreviewEntryDto> & { index: number; status: string },
): ImportPreviewEntryDto {
  return {
    agent: "claude-code",
    sessionId: "s",
    title: "t",
    projectPath: "/Users/alice/Ccode",
    cwd: null,
    provider: null,
    reason: null,
    needsClientRegister: false,
    ...over,
  };
}

test("pathBasename 取末段", () => {
  assert.equal(pathBasename("/Users/alice/Ccode"), "Ccode");
  assert.equal(pathBasename("C:\\work\\Ccode\\"), "Ccode");
});

test("同名注册项目优先推荐", () => {
  const r = suggestTargetDir("/Users/alice/Ccode", [
    "/Users/bob/docs/other",
    "/Users/bob/work/Ccode",
  ]);
  assert.equal(r.recommended, "/Users/bob/work/Ccode");
  assert.equal(r.fallbackName, "Ccode");
});

test("没有同名项目时只给末段名", () => {
  const r = suggestTargetDir("/Users/alice/foo", ["/tmp/bar"]);
  assert.equal(r.recommended, null);
  assert.equal(r.fallbackName, "foo");
});

test("Windows 同名忽略大小写", () => {
  const r = suggestTargetDir("C:\\Alice\\Ccode", ["D:\\bob\\ccode"], true);
  assert.equal(r.recommended, "D:\\bob\\ccode");
});

test("状态文案", () => {
  assert.equal(importStatusLabel("ok"), "可导入");
  assert.equal(importStatusLabel("needs-path"), "需选目录");
  assert.equal(importStatusLabel("conflict"), "已存在，将跳过");
  assert.equal(importStatusLabel("unsupported"), "不支持");
});

test("defaultDecisions：冲突默认跳过，needs-path 填推荐", () => {
  const d = defaultDecisions(
    [
      e({ index: 0, status: "ok", projectPath: "/a/Ccode" }),
      e({ index: 1, status: "needs-path", projectPath: "/a/Ccode" }),
      e({ index: 2, status: "conflict", projectPath: "/a/x" }),
      e({ index: 3, status: "unsupported", projectPath: "" }),
    ],
    ["/b/Ccode"],
  );
  assert.equal(d[0].skip, false);
  assert.equal(d[0].targetDir, "/a/Ccode");
  assert.equal(d[1].skip, false);
  assert.equal(d[1].targetDir, "/b/Ccode");
  assert.equal(d[2].skip, true);
  assert.equal(d[3].skip, true);
});

test("defaultDecisions：ok 默认落到文件 cwd，needs-path 仍按主仓名推荐", () => {
  const wt = "/a/.ccode/worktrees/search";
  const d = defaultDecisions(
    [
      e({
        index: 0,
        status: "ok",
        projectPath: "/a/Ccode",
        cwd: wt,
      }),
      e({
        index: 1,
        status: "needs-path",
        projectPath: "/a/Ccode",
        cwd: wt,
      }),
    ],
    ["/b/Ccode"],
  );
  assert.equal(d[0].targetDir, wt);
  assert.equal(d[1].targetDir, "/b/Ccode");
});

test("cwdDiffersFromProject：工作区路径与主仓不同", () => {
  assert.equal(
    cwdDiffersFromProject({
      projectPath: "/a/Ccode",
      cwd: "/a/.ccode/worktrees/search",
    }),
    true,
  );
  assert.equal(
    cwdDiffersFromProject({ projectPath: "/a/Ccode", cwd: "/a/Ccode" }),
    false,
  );
  assert.equal(
    cwdDiffersFromProject({ projectPath: "/a/Ccode", cwd: null }),
    false,
  );
});

test("canApply：needs-path 未填目录不可执行", () => {
  const entries = [
    e({ index: 0, status: "ok" }),
    e({ index: 1, status: "needs-path" }),
  ];
  const miss = canApply(entries, {
    0: { skip: false, targetDir: "/a" },
    1: { skip: false, targetDir: "" },
  });
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missing, [1]);
  const ok = canApply(entries, {
    0: { skip: false, targetDir: "/a" },
    1: { skip: false, targetDir: "/b" },
  });
  assert.equal(ok.ok, true);
});

test("canApply：跳过的 needs-path 不拦", () => {
  const r = canApply([e({ index: 0, status: "needs-path" })], {
    0: { skip: true, targetDir: "" },
  });
  assert.equal(r.ok, true);
});
