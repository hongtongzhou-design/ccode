import assert from "node:assert/strict";
import { test } from "node:test";
import {
  policyFieldHint,
  policyFieldMode,
  READONLY_CHANNEL_HINT,
  READONLY_PROBE_HINT,
  READONLY_TUI_HINT,
} from "../src/combo-field.ts";

test("不会思考：思考档隐藏，即使存了值", () => {
  assert.equal(
    policyFieldMode({
      capable: false,
      injectAllowed: false,
      probeFailed: false,
      stored: true,
    }),
    "hidden",
  );
});

test("通道 supported 且未体检失败：可编辑", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: true,
      probeFailed: false,
      stored: false,
    }),
    "edit",
  );
});

test("已存值但通道不通：只读", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: false,
      probeFailed: false,
      stored: true,
    }),
    "readonly",
  );
});

test("体检失败：锁只读", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: true,
      probeFailed: true,
      stored: true,
    }),
    "readonly",
  );
});

test("无存值且通道不通：不出现空编辑框", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: false,
      probeFailed: false,
      stored: false,
    }),
    "hidden",
  );
});

test("体检失败且未存值：只读，文案是体检失败不是通道不通", () => {
  const input = {
    capable: true,
    injectAllowed: true,
    probeFailed: true,
    stored: false,
  };
  assert.equal(policyFieldMode(input), "readonly");
  assert.equal(policyFieldHint(input), READONLY_PROBE_HINT);
  assert.notEqual(policyFieldHint(input), READONLY_CHANNEL_HINT);
});

test("优先级：不会该能力优先于体检失败，隐藏", () => {
  assert.equal(
    policyFieldMode({
      capable: false,
      injectAllowed: true,
      probeFailed: true,
      stored: true,
    }),
    "hidden",
  );
  assert.equal(
    policyFieldHint({
      capable: false,
      injectAllowed: true,
      probeFailed: true,
      stored: true,
    }),
    null,
  );
});

test("通道不通且已存值：只读挂通道文案", () => {
  const input = {
    capable: true,
    injectAllowed: false,
    probeFailed: false,
    stored: true,
  };
  assert.equal(policyFieldMode(input), "readonly");
  assert.equal(policyFieldHint(input), READONLY_CHANNEL_HINT);
});

test("优先级：体检失败优先于可注入，锁只读", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: true,
      probeFailed: true,
      stored: true,
    }),
    "readonly",
  );
});

test("persist 通道（仅设为全局生效）：可编辑，启动不注", () => {
  // qwen 温度/top_p 形态：injectAllowed=false 但 channel=persist → 可改可存
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: false,
      channel: "persist",
      probeFailed: false,
      stored: false,
    }),
    "edit",
  );
});

test("tui 通道（仅会话内命令）：已存值只读挂 TUI 文案", () => {
  // qwen effort 形态：/effort 直切存在，但存储值不随启动/写盘携带
  const input = {
    capable: true,
    injectAllowed: false,
    channel: "tui",
    probeFailed: false,
    stored: true,
  };
  assert.equal(policyFieldMode(input), "readonly");
  assert.equal(policyFieldHint(input), READONLY_TUI_HINT);
});

test("tui 通道未存值：不出现空编辑框", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: false,
      channel: "tui",
      probeFailed: false,
      stored: false,
    }),
    "hidden",
  );
});

test("persist 通道体检失败：仍锁只读", () => {
  assert.equal(
    policyFieldMode({
      capable: true,
      injectAllowed: false,
      channel: "persist",
      probeFailed: true,
      stored: true,
    }),
    "readonly",
  );
});
