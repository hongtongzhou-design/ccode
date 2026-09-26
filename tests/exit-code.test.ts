import assert from "node:assert/strict";
import test from "node:test";
import {
  exitCodeClause,
  exitCodeSummary,
  exitToneClass,
} from "../src/exit-code.ts";

test("0 是正常退出，且必须是 ok 色调——不能和失败共用一个颜色", () => {
  const s = exitCodeSummary(0);
  assert.equal(s.code, 0);
  assert.equal(s.tone, "ok");
  assert.match(s.label, /正常/);
});

test("-1 是后端的「原因未知」哨兵，不是崩溃", () => {
  // pty_kill（用户主动停止）、discard_spawned_pty、wait 超时三条路径都发 -1。
  // 把 -1 当崩溃染红，会让「我自己点了停止」看起来像出错。
  const s = exitCodeSummary(-1);
  assert.equal(s.tone, "muted");
  assert.equal(s.code, null, "不给假退出码，-1 不该显示成数字");
  assert.doesNotMatch(s.label, /异常|失败|错误/);
});

test("非数字与负数一律走原因未知分支", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -2, -99]) {
    const s = exitCodeSummary(bad);
    assert.equal(s.code, null, `${bad} 不该被当成真实退出码`);
    assert.equal(s.tone, "muted");
  }
});

test("常见信号退出码有白话说法", () => {
  assert.match(exitCodeSummary(130).label, /Ctrl-C/);
  assert.match(exitCodeSummary(137).label, /SIGKILL|强制/);
  assert.match(exitCodeSummary(143).label, /SIGTERM|终止/);
  assert.equal(exitCodeSummary(127).tone, "err");
  assert.equal(exitCodeSummary(126).tone, "err");
});

test("未知非零退出码保留数字并染红", () => {
  const s = exitCodeSummary(42);
  assert.equal(s.code, 42);
  assert.equal(s.tone, "err");
  assert.match(s.label, /42/);
});

test("三档 tone 映射到三个不同的类名", () => {
  const classes = new Set([
    exitToneClass("ok"),
    exitToneClass("warn"),
    exitToneClass("err"),
    exitToneClass("muted"),
  ]);
  assert.equal(classes.size, 4, "每种 tone 必须有各自的颜色");
});

test("回落 shell 的提示行只对异常退出加子句", () => {
  assert.equal(exitCodeClause(0), null, "「退出码 0」是噪音");
  assert.equal(exitCodeClause(-1), null, "原因未知不加假子句");
  assert.equal(exitCodeClause(137), "退出码 137");
});
