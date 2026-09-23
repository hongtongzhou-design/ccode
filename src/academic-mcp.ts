/** 文献检索步「配置学术检索 MCP」：预设入口与登录注入。 */

export type AcademicMcpAuth = "env" | "oauth";

export const ACADEMIC_MCP_PRESETS = [
  {
    name: "consensus",
    label: "Consensus",
    auth: "env" as const,
    envVar: "CONSENSUS_API_KEY",
    what: "按研究问题搜同行评议论文，带回标题、摘要、引用和期刊档",
  },
  {
    name: "undermind",
    label: "Undermind",
    auth: "oauth" as const,
    what: "语义深搜，补 OpenAlex 漏掉的相关工作",
  },
] as const;

export function isAcademicMcpTaskTitle(title: string): boolean {
  return title.includes("学术检索 MCP");
}

export interface AcademicMcpLogin {
  ready: boolean;
  note: string;
}

/** 「去终端登录」注入给 Agent 的第一句：按当前 Agent 给出可执行的 mcp login。 */
export function academicMcpLoginPrompt(agentId?: string | null): string {
  const cmd =
    agentId === "codex"
      ? "codex mcp login undermind"
      : agentId === "claude-code"
        ? "claude mcp login undermind"
        : null;
  const run = cmd
    ? `请立刻在本终端执行：${cmd}`
    : "请用当前 Agent 的 mcp login 登录 Undermind（Codex：codex mcp login undermind；Claude：claude mcp login undermind）";
  return `${run}。浏览器里授权 Undermind 账号。登录成功后不要在这个会话里检索，回到步骤点「开始」新开。`;
}
