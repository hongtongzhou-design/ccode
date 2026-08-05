import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionTransition,
  debounceAllows,
  NOTIFY_DEBOUNCE_MS,
  notifyBody,
  notifyTitle,
} from "../src/notify.ts";

test("attentionTransition 首次出现视为基线，任何状态都不通知", () => {
  assert.equal(attentionTransition(undefined, "working"), null);
  assert.equal(attentionTransition(undefined, "confirm"), null);
  assert.equal(attentionTransition(undefined, "done"), null);
  assert.equal(attentionTransition(undefined, null), null);
});

test("attentionTransition 非目标态 → 待确认/已完成 触发通知", () => {
  assert.equal(attentionTransition("working", "confirm"), "confirm");
  assert.equal(attentionTransition("working", "done"), "done");
  // 联动中断（null）后恢复目标态也算跃迁
  assert.equal(attentionTransition(null, "confirm"), "confirm");
  assert.equal(attentionTransition(null, "done"), "done");
  // 两个目标态之间互相切换同样各算一次「非→目标态」
  assert.equal(attentionTransition("done", "confirm"), "confirm");
  assert.equal(attentionTransition("confirm", "done"), "done");
});

test("attentionTransition 同态保持与非目标态不通知", () => {
  assert.equal(attentionTransition("confirm", "confirm"), null);
  assert.equal(attentionTransition("done", "done"), null);
  assert.equal(attentionTransition("working", "working"), null);
  assert.equal(attentionTransition("done", "working"), null);
  assert.equal(attentionTransition("confirm", "working"), null);
  assert.equal(attentionTransition("done", null), null);
});

test("debounceAllows 同标签窗口期内抑制，期满放行", () => {
  // 从未发送 → 放行
  assert.equal(debounceAllows(undefined, 1000), true);
  const last = 10_000;
  // 窗口期内 → 抑制
  assert.equal(debounceAllows(last, last + 1), false);
  assert.equal(debounceAllows(last, last + NOTIFY_DEBOUNCE_MS - 1), false);
  // 恰好满窗口 → 放行（语义断言，不依赖墙钟）
  assert.equal(debounceAllows(last, last + NOTIFY_DEBOUNCE_MS), true);
  assert.equal(debounceAllows(last, last + NOTIFY_DEBOUNCE_MS * 2), true);
});

test("notifyTitle/notifyBody 文案", () => {
  assert.equal(notifyTitle("读文献", "Claude Code"), "Claude Code · 读文献");
  assert.equal(notifyTitle("", "Codex"), "Codex");
  assert.equal(notifyBody("confirm"), "等待你的确认");
  assert.equal(notifyBody("done"), "任务已完成");
});
