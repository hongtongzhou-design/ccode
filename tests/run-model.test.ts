import assert from "node:assert/strict";
import test from "node:test";
import { inferTaskKind, isWorkbenchSurfaceRun } from "../src/run-model.ts";

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
