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
  // CodeBuddy 是 Anthropic 兼容协议（CODEBUDDY_API_KEY 鉴权），官方分国际站/中国站
  { name: "腾讯 CodeBuddy 国际站", agent: "codebuddy", baseUrl: "https://www.codebuddy.ai" },
  { name: "腾讯 CodeBuddy 中国站", agent: "codebuddy", baseUrl: "https://copilot.tencent.com" },
  {
    name: "DeepSeek（Anthropic 兼容）",
    agent: "codebuddy",
    baseUrl: "https://api.deepseek.com/anthropic",
    note: "CODEBUDDY_API_KEY 鉴权",
  },
  {
    name: "智谱 GLM（Anthropic 兼容）",
    agent: "codebuddy",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    note: "CODEBUDDY_API_KEY 鉴权",
  },
  // Cursor 不设预设：端点是 Cursor 专有协议（CURSOR_API_ENDPOINT），非 OpenAI/Anthropic 兼容，
  // 第三方供应商端点接上也不通，列出来只会误导
  // Grok Build 是 OpenAI 兼容协议（XAI_API_KEY 鉴权），官方端点公开
  { name: "xAI 官方", agent: "grok", baseUrl: "https://api.x.ai/v1" },
  // grok 归 OpenAI 兼容族，第三方兼容端点同样可用
  { name: "OpenRouter", agent: "grok", baseUrl: "https://openrouter.ai/api/v1", note: "聚合多家" },
  { name: "DeepSeek", agent: "grok", baseUrl: "https://api.deepseek.com/v1" },
  {
    name: "智谱 GLM",
    agent: "grok",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
];

/**
 * 没有预设的 agent 及其原因（v3.88）。
 * 空下拉看起来像功能坏了——两家「本来就不该有预设」必须说清楚，而不是给个空选择器。
 */
export const NO_PRESET_REASON: Record<string, string> = {
  gemini:
    "用 Google 官方账号/API 时 Base URL 留空即可，不需要填端点。",
  cursor:
    "Cursor 的端点是它自家协议（非 OpenAI/Anthropic 兼容），第三方供应商端点接上也不通，所以不设预设。",
};
