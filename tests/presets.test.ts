import assert from "node:assert/strict";
import test from "node:test";
import { PRESETS } from "../src/presets.ts";

const openAiAgents = ["codex", "qwen", "kimi", "opencode", "grok"];

function findPreset(agent: string, ...names: string[]) {
  return PRESETS.find((preset) => preset.agent === agent && names.includes(preset.name));
}

function findOpenAiProviderPreset(agent: string, provider: "kimi" | "qwen") {
  const names =
    provider === "kimi"
      ? agent === "kimi"
        ? ["Moonshot 官方"]
        : ["Moonshot 月之暗面"]
      : ["阿里云百炼（兼容模式）"];
  return PRESETS.find((preset) => preset.agent === agent && names.includes(preset.name));
}

test("OpenAI 兼容 agent 都有 Kimi 与通义千问快速预设", () => {
  for (const agent of openAiAgents) {
    assert.equal(
      findOpenAiProviderPreset(agent, "kimi")?.baseUrl,
      "https://api.moonshot.cn/v1",
      `${agent} 缺少 Kimi/Moonshot 预设`,
    );
    assert.equal(
      findOpenAiProviderPreset(agent, "qwen")?.baseUrl,
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      `${agent} 缺少通义千问/百炼预设`,
    );
  }
});

test("Qwen 与 Kimi 的兼容预设显式选择 openai 协议", () => {
  assert.equal(findOpenAiProviderPreset("qwen", "kimi")?.protocol, "openai", "qwen/kimi");
  assert.equal(findOpenAiProviderPreset("qwen", "qwen")?.protocol, "openai", "qwen/qwen");
  assert.equal(findOpenAiProviderPreset("kimi", "qwen")?.protocol, "openai", "kimi/qwen");
  assert.equal(findPreset("kimi", "Moonshot 官方")?.protocol, "kimi", "kimi 官方协议");
});
