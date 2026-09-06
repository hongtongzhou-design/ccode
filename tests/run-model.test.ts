import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeReuseKey,
  inferTaskKind,
  isDiscussPermission,
  isWorkbenchSurfaceRun,
  pickRecoverableRun,
} from "../src/run-model.ts";

test("canonicalizeReuseKey：wt: 升格为 lane:", () => {
  assert.equal(canonicalizeReuseKey("wt:/t"), "lane:/t");
  assert.equal(canonicalizeReuseKey("lane:/t"), "lane:/t");
});

test("inferTaskKind 按 reuseKey 前缀", () => {
  assert.equal(inferTaskKind("login:codex", "/x"), "login");
  assert.equal(inferTaskKind("reader:/p", "/p"), "reader");
  assert.equal(inferTaskKind("watch:s:/p", "/p"), "watch");
  assert.equal(inferTaskKind("office:/p:f", "/p"), "office_doc");
  assert.equal(inferTaskKind("ws:/wt", "/wt"), "pipeline_step");
  assert.equal(inferTaskKind("wt:/t", "/t"), "coding_lane");
  assert.equal(inferTaskKind("lane:/t", "/t"), "coding_lane");
  assert.equal(inferTaskKind("coding:/repo:project", "/repo"), "coding_lane");
  assert.equal(inferTaskKind("headless:ai-prompt:commit", "/tmp"), "scratch");
  assert.equal(inferTaskKind("", "/Users/a/ccode/scratch/x"), "scratch");
  assert.equal(
    inferTaskKind("", "/Users/a/ccode/workspaces/r/lit"),
    "pipeline_step",
  );
});

test("isWorkbenchSurfaceRun：登录与空闲 shell 不算正在进行", () => {
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "login:codex", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "watch:1:/p", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ reuseKey: "headless:ai-prompt:x", running: true }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ shell: true, running: false, attention: null }),
    false,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "ws:/wt",
      running: true,
      attention: "working",
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "reader:/p",
      running: false,
      shell: true,
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "custom:r1:/wt",
      shell: true,
      running: false,
    }),
    true,
  );
  assert.equal(
    isWorkbenchSurfaceRun({ running: true, attention: "working" }),
    true,
  );
});

test("isDiscussPermission：permission 优先于 readonly", () => {
  assert.equal(isDiscussPermission("discuss", false), true);
  assert.equal(isDiscussPermission("write_tree", true), false);
  assert.equal(isDiscussPermission(undefined, true), true);
});

test("自由任务标签按任务入口进入工作台白名单", () => {
  assert.equal(inferTaskKind("free:task-1", "/Users/me/project"), "free_research");
  assert.equal(
    isWorkbenchSurfaceRun({
      reuseKey: "task:task-1",
      running: true,
      attention: null,
    }),
    true,
  );
});

test("pickRecoverableRun：关标签后按项目找回可恢复 Run", () => {
  const caps = {
    canResume: true,
    canStop: true,
    streamsOutput: true,
    canReview: true,
    resumeReason: null,
  };
  const run = {
    id: "run-1",
    internal: false,
    closedAt: "2026-09-05T12:00:00+08:00",
    taskKind: "coding_lane",
    sessionId: "s1",
    runtime: "local_cli",
    capabilities: caps,
    projectRoot: "/repo",
    isolationPath: "/Users/me/ccode/worktrees/repo/feat",
  };
  assert.equal(pickRecoverableRun([run], "/repo")?.sessionId, "s1");
  assert.equal(pickRecoverableRun([{ ...run, internal: true }], "/repo"), null);
  assert.equal(pickRecoverableRun([{ ...run, taskKind: "watch" }], "/repo"), null);
  assert.equal(
    pickRecoverableRun([{ ...run, runtime: "custom", capabilities: { ...caps, canResume: false } }], "/repo"),
    null,
  );
});
