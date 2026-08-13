import type { McpEnvPair } from "./types";

/** MCP 内置预设：只收官方/权威 server；密钥一律 ${VAR} 引用环境变量，不落明文。
 *  加预设 = 加一条（McpPage 页头「预设 ▾」自动列出，点击预填「添加 server」表单） */
export interface McpPreset {
  /** 「预设 ▾」菜单里的文案，如「Consensus（学术搜索）」 */
  label: string;
  /** 打开表单时顶部提示（密钥要求等） */
  note: string;
  name: string;
  kind: "stdio" | "remote";
  url?: string;
  headers?: McpEnvPair[];
}

export const MCP_PRESETS: McpPreset[] = [
  // Consensus 官方 hosted MCP（lit-search 技能推荐）；需 Consensus API key。
  // Bearer 后用 ${VAR} 带括号写法：claude/codebuddy/cursor 只插值 ${VAR} 形式（matrix §9.3）
  {
    label: "Consensus（学术搜索）",
    note: "Consensus 官方 hosted MCP。需 Consensus API key：先设好环境变量 CONSENSUS_API_KEY 再分发，密钥按引用转写、不落明文。",
    name: "consensus",
    kind: "remote",
    url: "https://mcp.consensus.app/mcp",
    headers: [
      { key: "Authorization", value: "Bearer ${CONSENSUS_API_KEY}" },
    ],
  },
  // Undermind 官方 hosted MCP（lit-search 技能推荐）。认证走 OAuth（无 API key）：
  // 官方端点实测 401 + WWW-Authenticate（RFC 9728），支持它的客户端会自动拉起浏览器授权
  {
    label: "Undermind（文献语义搜索）",
    note: "Undermind 官方 hosted MCP。认证走 OAuth（没有 API key）：保存分发后，在对应 CLI 里登录一次即可（如 claude mcp login undermind），浏览器里授权 Undermind 账号，免费档即可用。",
    name: "undermind",
    kind: "remote",
    url: "https://mcp.undermind.ai/mcp",
  },
];
