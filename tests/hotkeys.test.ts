import assert from "node:assert/strict";
import test from "node:test";
import {
  comboFromEvent,
  comboLabel,
  eventMatchesCombo,
} from "../src/hotkeys.ts";

const ev = (over: Partial<Parameters<typeof comboFromEvent>[0]>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: "k",
  ...over,
});

test("comboFromEvent 纯修饰键 / 无修饰键返回 null", () => {
  assert.equal(comboFromEvent(ev({ metaKey: true, key: "Meta" })), null);
  assert.equal(comboFromEvent(ev({})), null);
});

test("comboFromEvent 生成规范化组合串", () => {
  assert.equal(comboFromEvent(ev({ metaKey: true })), "mod+k");
  assert.equal(
    comboFromEvent(ev({ metaKey: true, shiftKey: true, key: "K" })),
    "mod+shift+k",
  );
  assert.equal(comboFromEvent(ev({ ctrlKey: true, key: "\\" })), "mod+\\");
});

test("eventMatchesCombo 精确匹配修饰键集合", () => {
  assert.ok(eventMatchesCombo(ev({ metaKey: true }), "mod+k"));
  assert.ok(!eventMatchesCombo(ev({ metaKey: true, shiftKey: true }), "mod+k"));
  assert.ok(!eventMatchesCombo(ev({}), "mod+k"));
  assert.ok(eventMatchesCombo(ev({ ctrlKey: true, key: "\\" }), "mod+\\"));
});

test("eventMatchesCombo 空串（禁用）永不命中", () => {
  assert.ok(!eventMatchesCombo(ev({ metaKey: true }), ""));
});

test("comboLabel 渲染与禁用态", () => {
  assert.equal(comboLabel(""), "已禁用");
  // 非 mac 环境（测试运行在 node）mod 显示 Ctrl+
  const label = comboLabel("mod+k");
  assert.ok(label === "⌘K" || label === "Ctrl+K");
});
