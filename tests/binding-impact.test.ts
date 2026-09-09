import assert from "node:assert/strict";
import test from "node:test";
import { bindingImpactLine, protocolDisplayLabel } from "../src/binding-impact.ts";

test("protocolDisplayLabel 跟槽和 kimi/qwen 协议走", () => {
  assert.equal(protocolDisplayLabel("claude-code", null), "Anthropic");
  assert.equal(protocolDisplayLabel("codex", null), "Responses");
  assert.equal(protocolDisplayLabel("kimi", "kimi"), "Kimi");
  assert.equal(protocolDisplayLabel("kimi", "openai"), "OpenAI 兼容");
  assert.equal(protocolDisplayLabel("qwen", "anthropic"), "Anthropic");
});

test("bindingImpactLine 区分 Mesa 预选、外部 CLI 和仅选用", () => {
  assert.equal(
    bindingImpactLine({
      accountType: "api",
      gatewayName: "中转 A",
      agent: "claude-code",
      protocol: null,
      defaultModel: "sonnet",
      mesaLaunchDefault: false,
      cliGlobalWritten: false,
    }),
    "中转 A · Anthropic · 默认 sonnet · 仅 Mesa 内选用时生效",
  );
  assert.equal(
    bindingImpactLine({
      accountType: "api",
      gatewayName: "中转 A",
      agent: "claude-code",
      protocol: null,
      defaultModel: "sonnet",
      mesaLaunchDefault: true,
      cliGlobalWritten: true,
    }),
    "中转 A · Anthropic · 默认 sonnet · Mesa 启动预选 · 外部 CLI 上次写入",
  );
  assert.equal(
    bindingImpactLine({
      accountType: "official",
      agent: "codex",
      mesaLaunchDefault: true,
      cliGlobalWritten: false,
    }),
    "官方账号 · 跟随 CLI 登录 · Mesa 启动预选",
  );
});
