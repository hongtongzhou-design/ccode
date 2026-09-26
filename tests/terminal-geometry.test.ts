import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowPtyResize,
  allowSpawn,
  launchChromeBeforeMeasure,
} from "../src/terminal-geometry.ts";

test("测量前的启动栏：resume 与空指令不改，能注入的新指令才收起", () => {
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: true,
      prompt: "按意见改",
      promptInject: "positional",
    }),
    { kind: "keep" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: false,
      prompt: "   ",
      promptInject: "flag",
    }),
    { kind: "keep" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: false,
      prompt: "开工",
      promptInject: "positional",
    }),
    { kind: "collapse" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: false,
      prompt: "开工",
      promptInject: "flag",
    }),
    { kind: "collapse" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: false,
      prompt: "请粘贴",
      promptInject: "unsupported",
    }),
    { kind: "keep" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: true,
      prompt: "请粘贴",
      promptInject: "unsupported",
    }),
    { kind: "keep" },
  );
  assert.deepEqual(
    launchChromeBeforeMeasure({
      resume: false,
      prompt: "echo",
      promptInject: "none",
    }),
    { kind: "keep" },
  );
});

test("没量到格子不许启动", () => {
  assert.equal(allowSpawn(null), false);
  assert.equal(allowSpawn({ cols: 120, rows: 40 }), true);
});

test("进程起来之后，attach 和自动重绘不再改行列", () => {
  const next = { cols: 120, rows: 40 };
  assert.equal(allowPtyResize({ kind: "unset" }, next, false), true);
  assert.equal(allowPtyResize({ kind: "unset" }, next, true), false);
  assert.equal(allowPtyResize({ kind: "frozen" }, next, true), false);
  assert.equal(allowPtyResize({ kind: "frozen" }, { cols: 80, rows: 24 }, true), false);
  const measured = { kind: "measured" as const, cols: 120, rows: 40 };
  assert.equal(allowPtyResize(measured, next, true), false);
  assert.equal(allowPtyResize(measured, { cols: 119, rows: 40 }, true), false);
  assert.equal(allowPtyResize(measured, { cols: 80, rows: 24 }, true), false);
});
