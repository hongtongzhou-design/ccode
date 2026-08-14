export interface Profile {
  id: string;
  agent: string;
  name: string;
  /** 账号类型：api = 端点+密钥；official = CLI 官方账号登录（P1a），缺省 api */
  accountType: "api" | "official";
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
  accountType: "api" | "official";
  protocol: string | null;
  baseUrl: string | null;
  models: string[];
  extraEnv: Record<string, string>;
  /** 明文密钥，仅保存时提交；编辑时留空表示不修改 */
  apiKey: string | null;
}

/** 官方账号连接状态（official_account_status，P1a） */
export interface OfficialAccountStatusDto {
  /** 注册表已填该 agent 的官方账号规格 */
  supported: boolean;
  /** auth 文件检出凭证 */
  connected: boolean;
  /** 检测说明（漏报场景/文件异常） */
  detail: string | null;
  /** 终端内执行的登录命令（含二进制名；不支持时 null） */
  loginCommand: string | null;
  /** 配置文件冲突告警（只含文件名与变量名，不含密钥值） */
  conflicts: string[];
}

export interface ValidationCheckDto {
  status: "passed" | "failed" | "skipped";
  message: string;
  latencyMs: number | null;
}

export interface ProfileValidationDto {
  ok: boolean;
  checkedAt: string;
  local: ValidationCheckDto;
  cli: ValidationCheckDto;
  api: ValidationCheckDto;
}

export interface GlobalApplyResultDto {
  files: string[];
  validation: ProfileValidationDto;
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
  /** 工作区名命中项目流水线 steps[].workspaceName 时的步骤名；null 时回落显示 workspace 原名 */
  stepName: string | null;
  /** AI 生成的会话摘要（命中缓存；null = 尚未生成） */
  summary: string | null;
  /** 后端探测到该会话的 CLI 进程仍存活（外部 live；无终端标签可跳转） */
  live: boolean;
  /** 会话来源：普通 CLI 为 cli，Ccode 无头 AI 为 ccode-ai。 */
  source: string;
  /** 后端精确标记的 Ccode 内部 AI 会话。 */
  internal: boolean;
  /** 接力来源（P3 机制四）：该会话接自哪个 agent 的哪个会话；非接力会话为 null */
  handoffFromAgent: string | null;
  handoffFromSession: string | null;
  /** 归入的任务卡（卡片 = 对话的文件夹）；后端按项目回填卡片名，卡片删除后两者回落 null */
  taskId: string | null;
  taskName: string | null;
}

/** 接力目标（handoff_targets）：各 CLI 的安装与启动注入支持情况 */
export interface HandoffTargetDto {
  id: string;
  installed: boolean;
  /** false（kimi/opencode）= 无交互注入参数，简报路径需手动发送 */
  promptSupported: boolean;
}

/** build_handoff_brief 返回：简报文件路径 + 一句话概述 */
export interface HandoffBriefDto {
  filePath: string;
  summary: string;
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

export interface ConversationPageDto {
  messages: ChatMessageDto[];
  /** 下一页上界：文件会话为字节偏移，OpenCode 为 time_created。 */
  cursor: number | null;
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
  status: "creating" | "active" | "archived";
  createdAt: string;
  archivedAt: string | null;
  /** 「合并（保留工作区）」后置位：已合并进基准分支的时间；继续提交后按 ahead>0 隐藏 */
  mergedAt: string | null;
  /** 上游漂移提醒（启发式）：上游步骤晚于本步最后推进时间合并时，回填该上游步骤名 */
  staleUpstream: string | null;
  /** 仅创建时返回：setup 脚本执行结果（失败不阻断创建） */
  setupResult: SetupResultDto | null;
}

/** 引用健康检查（check_citation_health）：.md 引用键对照 references.bib 的可解析统计 */
export interface CitationHealthDto {
  totalRefs: number;
  resolved: number;
  missing: string[];
  bibFound: boolean;
}

/** 端口运行时监控（portwatch.rs）：一条 LISTEN 端口及其归属 */
export interface PortInfoDto {
  port: number;
  protocol: string;
  pid: number;
  process: string;
  /** 进程工作目录（Windows 端恒为 null） */
  cwd: string | null;
  ownerKind: "workspace" | "project" | "range" | "other";
  /** 白话归属文案（工作区 · xxx / 项目 · xxx / 端口段 … / 系统/其他），直接展示 */
  ownerLabel: string;
}

export interface RepoDto {
  path: string;
  name: string;
  /** 该仓库最近一条会话的更新时间；用于“最近项目”稳定排序。 */
  lastActive: string | null;
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

/** 保存历史时间线条目（project_history：当前分支 first-parent 主线） */
export interface HistoryEntryDto {
  hash: string;
  /** ISO 8601 提交时间 */
  time: string;
  author: string;
  /** 提交信息首行 */
  message: string;
  /** numstat 汇总；merge commit 无 diff，恒为 0 */
  files: number;
  additions: number;
  deletions: number;
  merge: boolean;
  /** 并入的分支名（解析不到为空串） */
  mergedBranch: string;
}

/** 工作区任务累计 diff（merge-base(base, branch) 为基准，W3） */
export interface WorkspaceDiffDto {
  inWorkspace: boolean;
  workspaceId: string;
  workspaceName: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  mergeBase: string;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

/** 人工事项（步骤的人机分工清单，声明在 project.toml steps[].human_tasks）：
 *  引擎不识语义（科研语义只进模板），只做文本/路径透传 */
export interface HumanTaskDto {
  /** 一句话说明（checklist 条目文本） */
  title: string;
  /** 引导说明（渠道选项等，只告知不推荐）；空串 = 无 */
  guidance: string;
  /** 交付落点（相对项目根/工作树）：目录（结尾 /）、精确文件、或「目录/通配」；
      空串 = 纯脑力事项，只能手动勾选 */
  target: string;
  /** 时机：before（开工前）| during（并行）| after（收尾） */
  timing: string;
}

/** 人工事项派生状态（list_human_task_states）：done = manual || detected，手动优先 */
export interface HumanTaskStateDto {
  step: string;
  title: string;
  guidance: string;
  target: string;
  timing: string;
  /** 落点位置检测到文件 */
  detected: boolean;
  /** 人手动勾过（勾了系统不再追问；取消勾选回到纯检测口径） */
  manual: boolean;
  done: boolean;
}

/** import_human_deliverable 返回：复制落位 + 提货单登记结果（登记失败不否决复制） */
export interface ImportDeliverableDto {
  destPath: string;
  destRel: string;
  destRoot: string;
  registered: boolean;
  registerError: string | null;
}

/** agent 人工请求（.ccode/help-wanted.md 约定文件，list_help_requests 返回） */
export interface HelpRequestDto {
  /** 来源根（工作树根或主仓根） */
  root: string;
  workspaceId: string | null;
  workspaceName: string | null;
  repoName: string;
  items: string[];
}

/** 提货单 artifacts.yaml 条目（§11.3 机制五）：产物本体不进 git，清单随分支提交传递 */
export interface ArtifactEntryDto {
  name: string;
  /** 绝对路径 */
  path: string;
  /** md5 hex */
  hash: string;
  size: number;
  /** 产出工作区名 */
  producedBy: string;
  createdAt: string;
}

/** 工作区健康度（ReadyToMerge 判定输入，W3） */
export interface WorkspaceHealthDto {
  uncommitted: boolean;
  ahead: number;
  behind: number;
  /** 与 base 是否冲突；无法判定时为 null */
  conflict: boolean | null;
  /** 冲突文件清单（conflict 为 true 时非空） */
  conflictFiles: string[];
  /** 主仓库未停在基准分支 */
  mainOffBase: boolean;
  /** 主仓库有未提交改动 */
  mainDirty: boolean;
  /** 冲突现场已落后基准（MERGE_HEAD ≠ 基准 tip），需重新同步后再选边 */
  staleBase: boolean;
  readyToMerge: boolean;
}

/** 产物待核验（收件箱）：活跃工作区绑定步骤的预期产物已全部产出且够新 */
export interface PendingArtifactDto {
  workspaceId: string;
  workspaceName: string;
  repoName: string;
}

export interface WorkspaceDriftIssueDto {
  code:
    | "creating_incomplete"
    | "repo_missing"
    | "branch_missing"
    | "worktree_missing"
    | "worktree_unregistered"
    | "worktree_branch_mismatch"
    | "archived_worktree_present"
    | "merge_in_progress";
  message: string;
}

export interface WorkspaceDriftDto {
  healthy: boolean;
  issues: WorkspaceDriftIssueDto[];
  canRemount: boolean;
  canRelocate: boolean;
  canMarkArchived: boolean;
  canCleanRecord: boolean;
  canResolveMerge: boolean;
}

/** git 提交/推送的分阶段结果；push 失败时 committed 仍为 true。 */
export interface GitCommitResultDto {
  committed: boolean;
  pushed: boolean;
  failedPhase: "push" | null;
  message: string;
  output: string;
}

/** 本地合并/归档的分阶段结果；归档失败时 merged 仍为 true。 */
export interface WorkspaceMergeResultDto {
  merged: boolean;
  archived: boolean;
  failedPhase: "state" | "archive" | null;
  message: string;
  output: string;
}

/** 推送分支/创建 PR 的分阶段结果。 */
export interface WorkspacePrResultDto {
  pushed: boolean;
  prCreated: boolean;
  prUrl: string | null;
  failedPhase: "push" | "pr" | null;
  message: string;
}

/** 技能库条目（技能页）：apps 记录各 agent 的应用开关 */
export interface SkillDto {
  id: string;
  name: string;
  description: string;
  /** local | zip | github | discovered */
  source: string;
  repo: string | null;
  repoRef: string | null;
  repoSubdir: string | null;
  sourceRevision: string | null;
  apps: Record<string, boolean>;
  installedAt: string;
  /** 用户自定义分类（null = 未分类；内部列表分组字段） */
  category: string | null;
  /** 用户自定义标签（名称后展示的小 pill，最多 4 个；旧数据无此字段时用 ?? [] 兜底） */
  tags?: string[];
  /** 内容已与库版本不一致的副本（所在 agent id 列表；空 = 无漂移） */
  /** 副本过期的 agent（后端空数组时省略该字段） */
  staleCopies?: string[];
  /** 各 agent 的分发形态（"symlink" | "copy"；仅启用的 agent 有键） */
  appModes?: Record<string, string>;
  /** SKILL.md 正文提及 MCP 工具/服务器（后端内容扫描，serde camelCase） */
  mentionsMcp: boolean;
  /** SKILL.md frontmatter 声明的产物路径（目录带尾斜杠，list 时现算）；空/缺 = 未声明，不参与产物冲突检测 */
  outputs?: string[];
}

/** skill_md_path 返回：SKILL.md 绝对路径 + 技能库目录（◈ 优化开终端的 cwd） */
export interface SkillPathDto {
  mdPath: string;
  dir: string;
}

export interface SkillImportConflictDto {
  name: string;
  existingId: string | null;
  source: string;
  updateAvailable: boolean;
}

export interface SkillImportResultDto {
  added: string[];
  updated: string[];
  skipped: string[];
  conflicts: SkillImportConflictDto[];
}

export interface SkillUpdateDto {
  id: string;
  updateAvailable: boolean;
  currentRevision: string | null;
  latestRevision: string | null;
  message: string;
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
  /** 统计范围内该 agent 用过的不同模型数 */
  modelCount: number;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

export interface ProjectUsageDto {
  projectPath: string;
  tokens: number;
  sessions: number;
  costUsd: number | null;
  costPartial: boolean;
  /** 后端登记的来源，例如 cli / ccode-ai。 */
  source: string;
  internal: boolean;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

export interface ModelUsageDto {
  model: string;
  input: number;
  output: number;
  costUsd: number | null;
  costPartial: boolean;
  source: string;
  internal: boolean;
}

/** 任务成本：usage 落在某工作区 worktree 内的部分按工作区成桶 */
export interface WorkspaceUsageDto {
  workspaceName: string;
  /** 所属项目（仓库）名 */
  repoName: string;
  tokensIn: number;
  tokensOut: number;
  /** 已计价模型份额合计；全部不明价为 null（显示 ~） */
  cost: number | null;
  costPartial: boolean;
  /** 统计范围内用过的不同模型数 */
  models: number;
  internal: boolean;
  /** 官方账号（订阅制）用量：不按量计费，费用栏显示「订阅」 */
  official: boolean;
}

export interface UsageStatsDto {
  cards: UsageCardsDto;
  byAgent: AgentUsageDto[];
  byProject: ProjectUsageDto[];
  byModel: ModelUsageDto[];
  /** 按工作区/任务归因的成本（仅含命中工作区的用量，按 token 降序） */
  byWorkspace: WorkspaceUsageDto[];
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
  { id: "codebuddy", label: "CodeBuddy", binary: "codebuddy" },
  { id: "cursor", label: "Cursor", binary: "cursor-agent" },
  { id: "grok", label: "Grok Build", binary: "grok" },
] as const;

/** 多协议 agent 的协议选项与默认值（其余 agent 返回 null，profile 不存协议） */
export const AGENT_PROTOCOLS: Record<string, { options: string[]; default: string }> = {
  qwen: { options: ["openai", "anthropic"], default: "openai" },
  kimi: { options: ["kimi", "anthropic", "openai"], default: "kimi" },
};

export interface ProfileUsageDto {
  input: number;
  output: number;
  costUsd: number | null;
  costPartial: boolean;
}

/** 项目注册表条目（§11.4 P1b；app.db projects 表） */
export interface ProjectDto {
  /** canonical 绝对路径，注册表主键 */
  path: string;
  name: string;
  createdAt: string | null;
  lastOpenedAt: string | null;
}

/** 档案卡 .ccode/project.toml 的资源条目 */
export interface ProjectResourceDto {
  name: string;
  path: string;
  /** paper | dataset | reference | other */
  type: string;
  readonly: boolean;
  note: string;
}

export interface ProjectStepRunDto {
  name: string;
  command: string;
  default: boolean;
}

/** 档案卡流水线步骤：工作区名/简报/技能/预期产物/人工事项均为可编辑预设 */
export interface ProjectStepDto {
  name: string;
  workspaceName: string;
  brief: string;
  expectedArtifacts: string[];
  skills: string[];
  run: ProjectStepRunDto[];
  /** 资源绑定：[[resources]] 条目的 path；空/缺省 = 绑定全部资源（向后兼容旧后端与旧配置） */
  resources?: string[];
  /** 人工事项（人机分工清单）；缺省 = 无（向后兼容旧后端与旧配置） */
  humanTasks?: HumanTaskDto[];
  /** 讨论种子（模板预置的「开工前建议想清楚的问题」）：卡片区按步骤列出，点击即聊；不进 TASK.md */
  discussionSeeds?: string[];
}

export interface ProjectConfigDto {
  /** 课题主题：一键开步写进 TASK.md「课题主题」段；可空 */
  topic?: string | null;
  artifactDir: string;
  resources: ProjectResourceDto[];
  steps: ProjectStepDto[];
  /** 「不使用研究流程」显式标记：true = 隐藏模板引导横幅与定时任务区块；选模板后后端自动清回 false */
  pipelineOptOut?: boolean;
}

/** 任务卡（list_task_cards 等）：挂在项目下的「对话文件夹」，无独立状态机 */
export interface TaskCardDto {
  /** "t-<短随机>"，项目内唯一 */
  id: string;
  /** 卡片名（同项目内唯一，大小写敏感） */
  name: string;
  /** 挂到的流水线步骤名（steps[].name）；未挂为 null */
  step: string | null;
  /** 开工后绑定的工作区名（预留字段，后端暂无写入入口） */
  workspace: string | null;
  /** 卡片种类：draft = 服务于任务书草稿的讨论卡；idea = 自由想法卡（只读纯聊、可融合进任务书）。
   *  旧卡缺 kind 时后端按 step 推断回填（step 非空 → draft，否则 idea） */
  kind: "idea" | "draft";
  createdAt: string;
}

/** read_project_config 返回：坏字段不阻断，逐条进 warnings */
export interface ProjectConfigReadDto {
  config: ProjectConfigDto;
  warnings: string[];
}

/** 用户另存的流水线模板（list/save/delete_pipeline_template）；内置模板在前端 pipeline-presets.ts */
export interface PipelineTemplateDto {
  id: string;
  name: string;
  description: string;
  steps: ProjectStepDto[];
  createdAt: string;
}

/** append_pipeline_steps 返回：实际追加步数 + 因重名（name/workspaceName）跳过的步骤名 */
export interface AppendStepsResultDto {
  appended: number;
  skipped: string[];
}

export interface DiscoveredResourceDto {
  /** 相对项目根，统一正斜杠 */
  path: string;
  /** paper | dataset | reference */
  type: string;
  size: number;
  mtime: string | null;
  /** 已在 project.toml 资源清单里登记过 */
  exists: boolean;
}

export interface EnsureGitDto {
  /** 本次执行了 git init */
  initialized: boolean;
  /** 本次新建了 .gitignore */
  gitignoreWritten: boolean;
}

export interface BootstrapCommitDto {
  /** 本次是否产生了提交 */
  committed: boolean;
  /** 实际提交的文件（相对仓库根，仅 .ccode 与 .gitignore 内） */
  paths: string[];
}

/** MCP server 清单项（src-tauri/src/mcp.rs；分发规格 = docs/agent-integration-matrix.md §10） */
export interface McpEnvPair {
  key: string;
  /** 字面值，或 $VAR / ${VAR} 引用环境变量（不落明文密钥） */
  value: string;
}

export interface McpServerDto {
  id: string;
  /** [A-Za-z0-9-]（下划线禁：gemini policy 引擎按下划线切分） */
  name: string;
  kind: "stdio" | "remote";
  command: string;
  args: string[];
  cwd: string;
  env: McpEnvPair[];
  url: string;
  headers: McpEnvPair[];
  /** agent id → 是否分发到其用户级配置 */
  apps: Record<string, boolean>;
}

// ===== 定时雷达（src-tauri/src/scheduler.rs） =====

/** 单次运行记录（status: "ok" | "error"；at 为 ISO 时间） */
export interface RunRecordDto {
  at: string;
  status: string;
  /** 脱敏后截断的简报/错误信息 */
  summary: string;
}

/** 定时任务（serde camelCase）；skill 目前固定 "lit-watch" */
export interface ScheduleDto {
  id: string;
  name: string;
  /** 项目根绝对路径（任务 cwd） */
  projectRoot: string;
  skill: string;
  /** null = 每次运行现解析（设置页 AI 专用 profile → 最近使用） */
  profileId: string | null;
  /** "daily" | "weekly" */
  frequency: string;
  /** weekly 时 1-7（周一=1）；daily 忽略 */
  weekday: number | null;
  hour: number;
  minute: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** 最近 20 条，新的在前 */
  history: RunRecordDto[];
}

export interface CreateScheduleInput {
  name?: string;
  projectRoot: string;
  skill?: string;
  profileId?: string | null;
  frequency: string;
  weekday?: number | null;
  hour: number;
  minute: number;
}

/** 更新补丁：字段全可选（不传 = 不改）；profileId 显式传 null = 清掉指定 profile 回到现解析 */
export interface UpdateSchedulePatch {
  name?: string;
  profileId?: string | null;
  frequency?: string;
  weekday?: number | null;
  hour?: number;
  minute?: number;
  enabled?: boolean;
}

/** scheduler-run-done 事件载荷（summary 已脱敏） */
export interface SchedulerRunDonePayload {
  scheduleId: string;
  projectRoot: string;
  status: string;
  summary: string;
}
