export interface Profile {
  id: string;
  agent: string;
  name: string;
  protocol: string | null;
  baseUrl: string | null;
  /** 可用模型列表，首个为默认 */
  models: string[];
  /** 附加环境变量，启动时注入，优先级高于 adapter 内置 env */
  extraEnv: Record<string, string>;
  /** 密钥尾号提示（如 "···abc1"），用于区分多个 key */
  keyHint: string | null;
  hasKey: boolean;
  /** 最近一次用该配置启动的时间（ISO）；null = 从未使用 */
  lastUsedAt: string | null;
}

export interface ProfileInput {
  agent: string;
  name: string;
  protocol: string | null;
  baseUrl: string | null;
  models: string[];
  extraEnv: Record<string, string>;
  /** 明文密钥，仅保存时提交；编辑时留空表示不修改 */
  apiKey: string | null;
}

export interface DetectResult {
  id: string;
  binaryPath: string | null;
  version: string | null;
}

export interface TokenUsageDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionMetaDto {
  agent: string;
  sessionId: string;
  projectPath: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  filePath: string;
  tokenUsage: TokenUsageDto | null;
  cliVersion: string | null;
  pinned: boolean;
  archived: boolean;
  customTitle: string | null;
  tags: string[];
  /** 源文件是否还在；不在则回放走 pin 快照 */
  alive: boolean;
  /** Codex resume/fork 链长度（同一对话合并为一个条目）；非 Codex 恒为 1 */
  chainCount: number;
  /** 会话发生在任务工作区（git worktree）里时的工作区名；此时 projectPath 已改写为真实仓库 */
  workspace: string | null;
}

export interface BlockDto {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  toolName: string | null;
}

export interface ChatMessageDto {
  role: string;
  blocks: BlockDto[];
  timestamp: string | null;
  usage: TokenUsageDto | null;
}

/** 任务工作区（§6.10）：一条 ccode/<name> 分支 + 一个 git worktree */
export interface SetupResultDto {
  ok: boolean;
  outputTail: string;
}

export interface WorkspaceDto {
  id: string;
  repoPath: string;
  repoName: string;
  name: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  portBase: number;
  status: "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
  /** 仅创建时返回：setup 脚本执行结果（失败不阻断创建） */
  setupResult: SetupResultDto | null;
}

export interface RepoDto {
  path: string;
  name: string;
}

/** 项目级 .ccode/settings.toml 三层合并结果（W2） */
export interface RunScriptDto {
  name: string;
  command: string;
  default: boolean;
}

export interface WsSettingsDto {
  filesToCopy: string[];
  runMode: string;
  setup: string | null;
  archive: string | null;
  run: RunScriptDto[];
}

export interface GitFileDto {
  path: string;
  /** "M" | "A" | "D" | "R" | "??" */
  status: string;
  additions: number | null;
  deletions: number | null;
}

/** 工作区任务累计 diff（merge-base(base, branch) 为基准，W3） */
export interface WorkspaceDiffDto {
  inWorkspace: boolean;
  baseBranch: string;
  mergeBase: string;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

/** 工作区健康度（ReadyToMerge 判定输入，W3） */
export interface WorkspaceHealthDto {
  uncommitted: number;
  ahead: number;
  behind: number;
  /** 与 base 是否冲突；无法判定时为 null */
  conflict: boolean | null;
  readyToMerge: boolean;
}

/** 技能库条目（技能页）：apps 记录各 agent 的应用开关 */
export interface SkillDto {
  id: string;
  name: string;
  description: string;
  /** local | zip | github | discovered */
  source: string;
  repo: string | null;
  apps: Record<string, boolean>;
  installedAt: string;
}

/** 未被纳管的已发现技能（各 agent 目录里已存在但不在库中） */
export interface DiscoveredSkillDto {
  name: string;
  description: string;
  path: string;
  fromAgent: string;
}

/** 用量统计（统计页） */
export interface UsageCardsDto {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sessions: number;
  costUsd: number | null;
  /** true = 桶里另含未计价模型的用量，costUsd 只是已计价份额 */
  costPartial: boolean;
}

export interface AgentUsageDto {
  agent: string;
  tokens: number;
  costUsd: number | null;
  costPartial: boolean;
}

export interface ProjectUsageDto {
  projectPath: string;
  tokens: number;
  sessions: number;
  costUsd: number | null;
  costPartial: boolean;
}

export interface ModelUsageDto {
  model: string;
  input: number;
  output: number;
  costUsd: number | null;
  costPartial: boolean;
}

export interface UsageStatsDto {
  cards: UsageCardsDto;
  byAgent: AgentUsageDto[];
  byProject: ProjectUsageDto[];
  byModel: ModelUsageDto[];
  /** 美元→人民币汇率（官方价换算用，默认 7.2） */
  rateUsdCny: number;
}

export const AGENTS = [
  { id: "claude-code", label: "Claude Code", binary: "claude" },
  { id: "codex", label: "Codex", binary: "codex" },
  { id: "gemini", label: "Gemini CLI", binary: "gemini" },
  { id: "qwen", label: "Qwen Code", binary: "qwen" },
  { id: "opencode", label: "OpenCode", binary: "opencode" },
  { id: "kimi", label: "Kimi Code", binary: "kimi" },
] as const;

/** 多协议 agent 的协议选项与默认值（其余 agent 返回 null，profile 不存协议） */
export const AGENT_PROTOCOLS: Record<string, { options: string[]; default: string }> = {
  qwen: { options: ["openai", "anthropic"], default: "openai" },
  kimi: { options: ["kimi", "anthropic", "openai"], default: "kimi" },
};
