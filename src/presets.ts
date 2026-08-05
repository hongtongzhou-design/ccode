/** 内置端点预设：只收录官方与公开的 OpenAI 兼容端点，不收录第三方商业中转 */
export interface Preset {
  name: string;
  agent: string;
  baseUrl: string;
  note?: string;
  /** 多协议 agent（qwen/kimi）的预设隐含协议，填充时一并写入表单 */
  protocol?: string;
}

export const PRESETS: Preset[] = [
  // Claude Code 需要 Anthropic 协议，只列官方与官方支持的 Anthropic 兼容端点（2026-08 核实）
  { name: "Anthropic 官方", agent: "claude-code", baseUrl: "https://api.anthropic.com" },
  {
    name: "智谱 GLM（Anthropic 兼容）",
    agent: "claude-code",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    note: "ANTHROPIC_AUTH_TOKEN 鉴权",
  },
  {
    name: "DeepSeek（Anthropic 兼容）",
    agent: "claude-code",
    baseUrl: "https://api.deepseek.com/anthropic",
    note: "ANTHROPIC_AUTH_TOKEN 鉴权",
  },
  // Codex 走 OpenAI Responses API，以下均为公开兼容端点
  { name: "OpenAI 官方", agent: "codex", baseUrl: "https://api.openai.com/v1" },
  { name: "OpenRouter", agent: "codex", baseUrl: "https://openrouter.ai/api/v1", note: "聚合多家" },
  { name: "DeepSeek", agent: "codex", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Moonshot 月之暗面", agent: "codex", baseUrl: "https://api.moonshot.cn/v1" },
  { name: "智谱 GLM", agent: "codex", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  {
    name: "阿里云百炼（兼容模式）",
    agent: "codex",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { name: "Ollama 本地", agent: "codex", baseUrl: "http://localhost:11434/v1", note: "无需密钥" },
  // Qwen Code 多协议，预设均为 openai 兼容端点（gemini/vertex-ai 协议暂不支持）
  {
    name: "阿里云百炼（兼容模式）",
    agent: "qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai",
  },
  {
    name: "OpenRouter",
    agent: "qwen",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "聚合多家",
    protocol: "openai",
  },
  { name: "DeepSeek", agent: "qwen", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
  { name: "智谱 GLM", agent: "qwen", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai" },
  // Kimi Code：Moonshot 官方端点，协议 kimi；兼容端点走 openai 协议（KIMI_MODEL_PROVIDER_TYPE=openai）
  {
    name: "Moonshot 官方",
    agent: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "kimi",
  },
  { name: "DeepSeek", agent: "kimi", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
  { name: "智谱 GLM", agent: "kimi", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai" },
  // OpenCode 走 @ai-sdk/openai-compatible，任意 OpenAI 兼容端点均可
  {
    name: "OpenRouter",
    agent: "opencode",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "聚合多家",
  },
  { name: "DeepSeek", agent: "opencode", baseUrl: "https://api.deepseek.com/v1" },
  { name: "智谱 GLM", agent: "opencode", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  {
    name: "阿里云百炼（兼容模式）",
    agent: "opencode",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  // Gemini CLI 用 Google 官方时 Base URL 留空即可，不设预设
];
