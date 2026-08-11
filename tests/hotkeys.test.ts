import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDecision,
  comboFromEvent,
  comboLabel,
  eventMatchesCombo,
  PAGE_HOTKEY_DEFS,
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

test("captureDecision：Esc 取消 / 纯修饰键忽略", () => {
  assert.deepEqual(captureDecision(ev({ key: "Escape" }), []), {
    action: "cancel",
  });
  assert.deepEqual(captureDecision(ev({ metaKey: true, key: "Meta" }), []), {
    action: "ignore",
  });
  assert.deepEqual(captureDecision(ev({}), []), { action: "ignore" });
});

test("captureDecision：冲突拒绝（多冲突方任一命中即拒）/ 正常保存", () => {
  assert.deepEqual(captureDecision(ev({ metaKey: true }), ["mod+k"]), {
    action: "conflict",
    combo: "mod+k",
  });
  // 多个冲突方：命中任意一个都拒绝
  assert.deepEqual(
    captureDecision(ev({ metaKey: true, key: "2" }), ["mod+k", "mod+2"]),
    { action: "conflict", combo: "mod+2" },
  );
  assert.deepEqual(captureDecision(ev({ metaKey: true }), ["mod+\\"]), {
    action: "save",
    combo: "mod+k",
  });
  // 冲突方为禁用（空串）时不判冲突
  assert.deepEqual(captureDecision(ev({ metaKey: true }), [""]), {
    action: "save",
    combo: "mod+k",
  });
});

test("PAGE_HOTKEY_DEFS：八页、顺序与默认绑定唯一", () => {
  assert.equal(PAGE_HOTKEY_DEFS.length, 8);
  assert.deepEqual(
    PAGE_HOTKEY_DEFS.map((p) => p.id),
    ["workspaces", "terminal", "sessions", "profiles", "skills", "mcp", "stats", "settings"],
  );
  const combos = PAGE_HOTKEY_DEFS.map((p) => p.combo);
  assert.equal(new Set(combos).size, 8, "默认绑定不得互相冲突");
  assert.deepEqual(combos, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `mod+${n}`));
});
