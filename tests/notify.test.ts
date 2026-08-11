import assert from "node:assert/strict";
import test from "node:test";
import {
  attentionTransition,
  debounceAllows,
  NOTIFY_BODY,
  NOTIFY_DEBOUNCE_MS,
  notifyTitle,
} from "../src/notify.ts";

test("attentionTransition 首次出现视为基线，任何状态都不通知", () => {
  assert.equal(attentionTransition(undefined, "working"), false);
  assert.equal(attentionTransition(undefined, "confirm"), false);
  assert.equal(attentionTransition(undefined, "done"), false);
  assert.equal(attentionTransition(undefined, null), false);
});

test("attentionTransition 只在非待确认 → 待确认时触发", () => {
  assert.equal(attentionTransition("working", "confirm"), true);
  // 联动中断（null）后恢复待确认也算跃迁
  assert.equal(attentionTransition(null, "confirm"), true);
  assert.equal(attentionTransition("done", "confirm"), true);
  // 「已回复」每回合都发生、不阻塞决策，永不通知
  assert.equal(attentionTransition("working", "done"), false);
  assert.equal(attentionTransition(null, "done"), false);
  assert.equal(attentionTransition("confirm", "done"), false);
});

test("attentionTransition 同态保持与非目标态不通知", () => {
  assert.equal(attentionTransition("confirm", "confirm"), false);
  assert.equal(attentionTransition("done", "done"), false);
  assert.equal(attentionTransition("working", "working"), false);
  assert.equal(attentionTransition("done", "working"), false);
  assert.equal(attentionTransition("confirm", "working"), false);
  assert.equal(attentionTransition("done", null), false);
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

test("notifyTitle/通知正文文案", () => {
  assert.equal(notifyTitle("读文献", "Claude Code"), "Claude Code · 读文献");
  assert.equal(notifyTitle("", "Codex"), "Codex");
  assert.equal(NOTIFY_BODY, "等待你的确认");
});
