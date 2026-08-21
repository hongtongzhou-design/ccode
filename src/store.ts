import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isLightTheme } from "./themes";
import {
  dismissHelp,
  dismissInboxItem,
  loadHelpDismissed,
  loadInboxDismissed,
} from "./inbox";
import type { RunOverviewInput } from "./run-overview";
import type {
  DetectResult,
  HandoffBriefDto,
  Profile,
  ProfileInput,
  RepoDto,
  SessionMetaDto,
  TaskCardDto,
} from "./types";

const RECENT_REPOS_CACHE_KEY = "ccode.recentRepos";

function cachedRecentRepos(): RepoDto[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(RECENT_REPOS_CACHE_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value.filter(
          (repo): repo is RepoDto =>
            typeof repo?.path === "string" && typeof repo?.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** 应用设置（SettingsPage；后端 get_settings/update_settings 契约） */
export interface AppSettings {
  terminalFontSize: number;
  terminalFontFamily?: string;
  terminalPalette?: string; // 四套深色 + 四套配对浅色，见 terminal-palettes.ts PALETTE_LIST
  scrollback: number;
  rateUsdCny: number;
  brewMirror: boolean;
  /** 长任务 OS 通知：注意力跃迁且窗口未聚焦时发系统通知（默认开） */
  notificationsEnabled: boolean;
  theme: string;
  /** ◈ AI 功能固定使用的 profile id；null/undefined = 自动（最近使用） */
  aiProfileId?: string | null;
  /** ◈ AI 功能按功能独立配置：键 = 功能 key（commit/summarize/pr/distill/conflict/translate，
      见 ai.rs FN_* 常量），值 = profile id；键缺失 = 跟随默认（aiProfileId） */
  aiProfiles?: Record<string, string>;
  /** 每个 agent 的默认 profile（agent id → profile id）：启动栏选完 agent 后预选它。
   *  解析顺序 显式默认 > 上次使用 > 首个配置 */
  defaultProfiles?: Record<string, string>;
  /** 启动时进入哪一页（页面 id）；缺省 = workspaces */
  startPage?: string;
  /** 「隐藏」的 profile id：只影响启动栏下拉分组（沉到「更多」），不删数据、不改启动行为 */
  hiddenProfiles?: string[];
  /** 对话页「⇗ 外部恢复」的终端应用；auto/undefined = 按优先级探测 */
  externalTerminal?: string;
  /** 精确注意力标记（agent hooks 桥接）：agent id → 开关，键缺失 = 关；
      开/关走专用命令 set_hooks_attention（写各家 hooks 配置），勿单独 patch */
  hooksAttention?: Record<string, boolean>;
  /** 快捷键绑定（"mod+shift+k" 格式，mod=⌘/Ctrl；空串 = 禁用） */
  hotkeyPalette?: string;
  hotkeyHideChrome?: string;
  /** ⌘1–⌘8 页切整组总开关（关 = 全部页切绑定不生效） */
  hotkeyPageSwitch?: boolean;
  /** 页切逐页绑定：键 = 页面 id（hotkeys.ts PAGE_HOTKEY_DEFS），值 = 组合串；
      键缺失 = 该页用默认绑定（mod+1..mod+8） */
  hotkeyPages?: Record<string, string>;
  /** 想法期只读保护（卡片区「聊想法」，默认开）：开 = 支持的 CLI 注入只读/计划模式参数 +
      预填指令带不动文件约束；关 = 纯聊天 */
  discussReadonly?: boolean;
}

/** 运行时切主题：Tailwind v4 @theme 的工具类引用 CSS 变量，覆盖 dataset.theme 即生效；
 *  同时同步原生窗口外观——原生 <select> 下拉/滚动条按 NSWindow appearance 渲染，
 *  只改 CSS 变量时深色主题下弹出的仍是系统浅色列表 */
export function applyTheme(id: string) {
  const theme = id || "midnight";
  document.documentElement.dataset.theme = theme;
  const light = isLightTheme(theme);
  void getCurrentWindow()
    .setTheme(light ? "light" : "dark")
    .catch(() => {});
}

/** 工作区页 → 终端页的交接：新开一个标签，预填 cwd + 注入 env（如端口段） */
export interface PendingTerminal {
  cwd: string;
  extraEnv: Record<string, string>;
  title?: string;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：只开 shell，不走 agent 启动流程 */
  shellOnly?: boolean;
  /** run 脚本来源的工作区 id（nonconcurrent 互斥追踪用） */
  wsId?: string;
  /** 会话恢复：以 --resume/--continue 语义重启该会话（SessionLink 确定性锁定） */
  resume?: {
    agentId: string;
    sessionId: string;
    /** 会话的 model_provider（codex rollout 元信息）：恢复时按它挑兼容 profile，
     *  "ccode" = 内联 provider 会话，必须用带 Base URL 的配置（见 resume-profile.ts） */
    provider?: string | null;
  };
  /** 指定启动配置（未给则按 ccode.lastProfile → 该 agent 首个配置兜底） */
  autoLaunchProfileId?: string;
  /** 预填启动栏（工作区记住上次配置） */
  agentId?: string;
  profileId?: string;
  model?: string;
  /** 建好标签就直接启动（不用再点一次「启动」）。会话恢复隐含为 true；
   *  「快速开聊」显式置 true——弹层里已经确认过 agent/配置/目录，再点一次纯属多余。
   *  找不到对应 profile 时自动降级为「只预填、不启动」（见 TerminalView 的 autoStart 守卫）。 */
  autoStart?: boolean;
  /** 一键开步预填的首条指令：启动时注入 CLI，启动成功后清除（一次性） */
  initialPrompt?: string;
  /** 打开后右栏直接落到指定页签（如卡片区「主仓改动」提醒跳到改动面板） */
  rightTab?: "git";
  /** 「最干净的终端」：落地即收起工作树与右栏（走既有专注终端语义，Esc 可退）。
   *  给「快速开聊」用——没有项目上下文时三个面板都没东西可给，摆着只是噪音 */
  clean?: boolean;
  /** 开聊自动带开文件预览（路径 + 预览根）：一次性交接不落盘
      （terminal-tab-persistence 白名单本就不含它） */
  previewPath?: string;
  previewRoot?: string;
  /** 「聊想法」只读模式：pty_spawn 注入只读/计划模式参数（硬保护，支持的 CLI 才生效） */
  readonly?: boolean;
  /** 复用键：已有同 key 标签时切换到它而不是新开（「快速开聊」「跟 AI 商量一下」等
      重复入口防标签堆积）。仅内存匹配，不进重启持久化白名单（恢复占位不参与复用） */
  reuseKey?: string;
  /** 步骤认领（「跟 AI 商量一下」）：启动 spawn 时以最终 agent/cwd 登记
      claim_next_session_for_step，让会话归到该步骤（「本步骤的对话」按 stepName 过滤）。
      不在发起时提前登记——启动栏还可改 agent/目录，spawn 时的实时值才作数 */
  stepName?: string;
}

/** 工作区页 / 改动面板 → 终端全宽审阅视图的一次性交接。 */
export interface WorkspaceReviewRequest {
  worktreePath: string;
  /** 工作区列表的更多操作可直接定位到评审中的对应完成动作；
      resolve-conflict 表示「解决冲突」入口，允许评审层自动准备冲突两侧。 */
  action?: "pr" | "archive" | "resolve-conflict";
  /** 同一路径的重复请求也要重新触发评审内的定位动作。 */
  requestId: string;
}

export function sessionRuntimeKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

/** 「待你处理」收件箱条目（可序列化，闭包不进 store）；
    action 由消费方统一派发（全部走 store 一次性请求 + 页面跳转） */
export interface InboxItem {
  key: string;
  /** 状态点语义色 class（bg-warn-text / bg-ok-text） */
  dot: string;
  text: string;
  actionLabel: string;
  /** 仅 help: 条目携带：请求条目签名（dismiss 时连同 root 写入屏蔽表） */
  dismissSignature?: string;
  action:
    | {
        type: "review";
        worktreePath: string;
        intent?: "pr" | "archive" | "resolve-conflict";
      }
    | { type: "tab"; tabId: string }
    | { type: "session"; agent: string; sessionId: string }
    | { type: "digest" }
    | { type: "artifacts"; workspaceId: string }
    | { type: "project"; projectRoot: string }
    | { type: "help"; projectRoot: string }
    | { type: "profiles" };
}

/** 「◈ 提炼接力」后台任务（v3.60）：AI 蒸馏与 DigestPicker 解耦——picker 可关可开，
    同一会话复用结果不重复发起；ready 且未消费时进收件箱「待发送」 */
export interface DigestJob {
  agent: string;
  sessionId: string;
  filePath: string;
  cwd: string;
  title: string | null;
  status: "running" | "ready" | "error";
  brief?: HandoffBriefDto;
  error?: string;
  /** 已选定发送目标/用户丢弃：从收件箱摘除（简报文件仍在磁盘，重开 picker 复用） */
  consumed: boolean;
}

/** 收件箱条目动作统一派发（工作区页 strip 与 App 标题栏收件箱共用） */
export function runInboxAction(item: InboxItem) {
  const s = useAppStore.getState();
  if (item.action.type === "review") {
    s.setWorkspaceReviewRequest({
      worktreePath: item.action.worktreePath,
      action: item.action.intent,
      requestId: crypto.randomUUID(),
    });
    s.setPage("terminal");
  } else if (item.action.type === "tab") {
    s.setFocusTabReq(item.action.tabId);
    s.setPage("terminal");
  } else if (item.action.type === "session") {
    s.setOpenSessionReq({
      agent: item.action.agent,
      sessionId: item.action.sessionId,
    });
    s.setPage("sessions");
  } else if (item.action.type === "digest") {
    s.setDigestOpenReq(Date.now());
    s.setPage("sessions");
  } else if (item.action.type === "artifacts") {
    s.setArtifactCheckReq(item.action.workspaceId);
    s.setPage("workspaces");
  } else if (item.action.type === "project") {
    s.setSelectProjectReq(item.action.projectRoot);
    s.setPage("workspaces");
  } else if (item.action.type === "help") {
    // 人工请求「去查看」：选中项目之外还要弹出完整内容层——请求全文在 strip 行里只有 40 字截断预览
    s.setSelectProjectReq(item.action.projectRoot);
    s.setHelpViewReq(item.action.projectRoot);
    s.setPage("workspaces");
  } else {
    s.setPage("profiles");
  }
}

interface AppState {
  profiles: Profile[];
  agents: DetectResult[];
  sessions: SessionMetaDto[];
  /** 后端按最近会话活跃度排序的仓库；本地缓存用于终端首开即时展示。 */
  recentRepos: RepoDto[];
  recentReposLoading: boolean;
  recentReposLoaded: boolean;
  loadRecentRepos: () => Promise<void>;
  /** 当前页面（nav id），放 store 里让任意页面可跳转 */
  page: string;
  setPage: (p: string) => void;
  /** 侧栏收缩状态（localStorage 持久化，品牌区点击切换） */
  navCollapsed: boolean;
  toggleNavCollapsed: () => void;
  /** 执行态全隐藏侧栏 chrome（⌘\ 切换，session 级不持久化） */
  chromeHidden: boolean;
  toggleChromeHidden: () => void;
  /** 待消费的终端启动请求；终端页可见时消费并清空 */
  pendingTerminal: PendingTerminal | null;
  setPendingTerminal: (p: PendingTerminal | null) => void;
  workspaceReviewRequest: WorkspaceReviewRequest | null;
  setWorkspaceReviewRequest: (request: WorkspaceReviewRequest | null) => void;
  /** 终端标签运行状态镜像（TerminalPage 写入；工作区首页「待你处理」跨页只读） */
  terminalRunInputs: RunOverviewInput[];
  setTerminalRunInputs: (inputs: RunOverviewInput[]) => void;
  /** 「待你处理」收件箱条目镜像（WorkspacesPage 唯一写入方，签名变更才写）；
      App 标题栏收件箱与工作区页 strip 共同消费；action 为可序列化跳转描述 */
  inboxItems: InboxItem[];
  setInboxItems: (items: InboxItem[]) => void;
  /** help: 条目屏蔽表（{ root: 条目签名 }，localStorage ccode.helpDismissed 持久化；
      签名随文件内容变化，内容一变自动复现）。签名一致时 WorkspacesPage 不生成该条目 */
  helpDismissed: Record<string, string>;
  dismissHelpRequest: (root: string, signature: string) => void;
  /** 通用条目屏蔽表（v3.88）：任意收件箱条目可忽略，状态变化后自动复现 */
  inboxDismissed: Record<string, string>;
  dismissInbox: (item: InboxItem) => void;
  /** 一次性「跳终端页并激活标签」请求（首页待办点击发起），终端页可见时消费并清空 */
  focusTabReq: string | null;
  setFocusTabReq: (tabId: string | null) => void;
  /** 工作区页资源面板「查看」/ 步骤产物 → 终端页预览的交接（绝对路径，终端页消费并清空）；
      root 可选：文本预览的后端根约束（不给则回落活动标签 cwd） */
  previewReq: { path: string; name: string; root?: string } | null;
  setPreviewReq: (r: { path: string; name: string; root?: string } | null) => void;
  /** 沉浸式阅读区的一次性打开请求（终端页消费并清空）：PDF 绝对路径 + 所属项目根；
      notePath 指定后笔记栏直接编辑该 md（不按 PDF slug 另建模板笔记） */
  readerReq: { pdfPath: string; projectRoot: string; notePath?: string } | null;
  setReaderReq: (
    r: { pdfPath: string; projectRoot: string; notePath?: string } | null,
  ) => void;
  /** 步骤胶囊「📁」→ 终端页文件树切根的一次性交接（终端页消费并清空） */
  enterCwdReq: string | null;
  setEnterCwdReq: (p: string | null) => void;
  /** 运行中的 run 脚本：工作区 id → 终端标签 id（nonconcurrent 互斥） */
  runningScripts: Record<string, string>;
  setRunningScript: (wsId: string, tabId: string | null) => void;
  /** 终端里正在进行的会话：agent+sessionId → 标签 id（防止跨 CLI 同 id 串联） */
  liveSessions: Record<string, string>;
  setLiveSession: (
    agent: string,
    sessionId: string,
    tabId: string | null,
  ) => void;
  /** 对话页 → 终端页的焦点跳转请求（终端页消费并清空） */
  focusTabId: string | null;
  focusTab: (tabId: string | null) => void;
  /** 工作区页 → 对话页的搜索词交接（对话页消费并清空） */
  sessionsQuery: string | null;
  /** 请求对话页打开指定会话（终端页「⤴对话」跳转用） */
  openSessionReq: { agent: string; sessionId: string } | null;
  setOpenSessionReq: (r: { agent: string; sessionId: string } | null) => void;
  setSessionsQuery: (q: string | null) => void;
  /** 选段「✦ 沉淀为技能」→ 技能页的一次性草稿交接（技能页可见时打开新建 modal 预填并清空） */
  skillDraftReq: { name: string; description: string; content: string } | null;
  setSkillDraftReq: (
    r: { name: string; description: string; content: string } | null,
  ) => void;
  /** 「◈ 提炼接力」后台任务（生成与 picker 解耦；收件箱「待发送」只读） */
  digestJob: DigestJob | null;
  /** 发起提炼；同一会话 running/ready 时复用不重复发起，force 用于失败后重试 */
  startDigestJob: (
    src: {
      agent: string;
      sessionId: string;
      filePath: string;
      cwd: string;
      title: string | null;
    },
    force?: boolean,
  ) => void;
  /** 已选定发送目标/用户丢弃：从收件箱摘除（简报文件保留，重开 picker 复用） */
  consumeDigestJob: () => void;
  /** 收件箱「去发送」→ 对话页重开 DigestPicker 的一次性请求（nonce 触发） */
  digestOpenReq: number | null;
  setDigestOpenReq: (n: number | null) => void;
  /** 收件箱「去核验」→ 工作区页展开对应任务行产物清单的一次性请求 */
  artifactCheckReq: string | null;
  setArtifactCheckReq: (id: string | null) => void;
  /** 对话页卡片 chip → 工作区页选中对应项目的一次性请求（项目根路径，工作区页消费并清空） */
  /** 当前项目·步骤上下文镜像（WorkspacesPage 唯一写入方）：顶栏跨页展示「我在哪」。
   *  只读消费，不新增轮询——数据本就在工作区页手里 */
  contextLabel: { project: string; step: string | null } | null;
  setContextLabel: (v: { project: string; step: string | null } | null) => void;
  selectProjectReq: string | null;
  /** 收件箱人工请求「去查看」的一次性请求（项目根路径）：工作区页弹出该来源的完整请求内容层 */
  helpViewReq: string | null;
  setHelpViewReq: (path: string | null) => void;
  /** 对话页作用域筛选的一次性请求（工作区页「本步骤的对话」→ 落成 step chip） */
  sessionScopeReq: { kind: "project" | "step" | "task" | "agent"; value: string; label: string } | null;
  setSessionScopeReq: (
    r: { kind: "project" | "step" | "task" | "agent"; value: string; label: string } | null,
  ) => void;
  setSelectProjectReq: (path: string | null) => void;
  /** 任务卡（按项目根缓存；list_task_cards 对非项目目录返回空表不报错） */
  taskCards: Record<string, TaskCardDto[]>;
  /** 拉取并缓存某项目的任务卡；失败抛错由调用方行内报错 */
  loadTaskCards: (projectRoot: string) => Promise<TaskCardDto[]>;
  /** 新建卡片（同项目重名后端拒绝）；成功后刷新缓存并返回新卡片。
   *  kind 缺省由后端推断（step 非空 → draft，否则 idea）；想法区建卡传 "idea" */
  createCard: (
    projectRoot: string,
    name: string,
    step: string | null,
    kind?: "idea" | "draft",
  ) => Promise<TaskCardDto>;
  renameCard: (
    projectRoot: string,
    taskId: string,
    newName: string,
  ) => Promise<void>;
  /** 删除卡片（后端顺手清掉所有会话的 task_id 归置） */
  deleteCard: (projectRoot: string, taskId: string) => Promise<void>;
  /** 会话归入/移出卡片（taskId null/空白 = 移出）；成功后刷新会话列表让 chip 即时更新 */
  assignSessionTask: (
    agent: string,
    sessionId: string,
    taskId: string | null,
  ) => Promise<void>;
  /** profile 三层验证失败镜像（ProfilesPage 写入：失败登记、通过/编辑后清除），收件箱只读 */
  profileIssues: Record<string, { name: string; agent: string; reason: string }>;
  setProfileIssue: (
    id: string,
    issue: { name: string; agent: string; reason: string } | null,
  ) => void;
  /** 应用设置（启动时加载；update 合并写回并即时应用主题） */
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** 应用自更新：check() 命中的可用更新（null=已是最新/未检查完/检查失败） */
  appUpdate: Update | null;
  /** 启动时静默检查应用更新；失败（无网络/dev 模式）吞掉不打扰 */
  checkAppUpdate: () => Promise<void>;
  loadAll: () => Promise<void>;
  /** 拉取全部 agent 的会话元数据，返回最新列表供轮询比对 */
  loadSessions: () => Promise<SessionMetaDto[]>;
  saveProfile: (id: string | null, input: ProfileInput) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  duplicateProfile: (id: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  profiles: [],
  agents: [],
  sessions: [],
  recentRepos: cachedRecentRepos(),
  recentReposLoading: false,
  recentReposLoaded: false,
  loadRecentRepos: async () => {
    if (get().recentReposLoading) return;
    set({ recentReposLoading: true });
    try {
      const recentRepos = await invoke<RepoDto[]>("list_repos");
      localStorage.setItem(RECENT_REPOS_CACHE_KEY, JSON.stringify(recentRepos));
      set({ recentRepos, recentReposLoaded: true });
    } finally {
      set({ recentReposLoading: false });
    }
  },
  page: "workspaces",
  setPage: (p) => set({ page: p }),
  navCollapsed: localStorage.getItem("ccode.navCollapsed") === "1",
  toggleNavCollapsed: () =>
    set((s) => {
      localStorage.setItem("ccode.navCollapsed", s.navCollapsed ? "0" : "1");
      return { navCollapsed: !s.navCollapsed };
    }),
  chromeHidden: false,
  toggleChromeHidden: () => set((s) => ({ chromeHidden: !s.chromeHidden })),
  pendingTerminal: null,
  setPendingTerminal: (p) => set({ pendingTerminal: p }),
  workspaceReviewRequest: null,
  setWorkspaceReviewRequest: (request) =>
    set({ workspaceReviewRequest: request }),
  terminalRunInputs: [],
  setTerminalRunInputs: (inputs) => set({ terminalRunInputs: inputs }),
  inboxItems: [],
  setInboxItems: (items) => set({ inboxItems: items }),
  inboxDismissed: loadInboxDismissed(),
  dismissInbox: (item) =>
    set((st) => ({ inboxDismissed: dismissInboxItem(item, st.inboxDismissed) })),
  helpDismissed: loadHelpDismissed(),
  dismissHelpRequest: (root, signature) =>
    set({ helpDismissed: dismissHelp(root, signature) }),
  focusTabReq: null,
  setFocusTabReq: (tabId) => set({ focusTabReq: tabId }),
  previewReq: null,
  setPreviewReq: (r) => set({ previewReq: r }),
  readerReq: null,
  setReaderReq: (r) => set({ readerReq: r }),
  enterCwdReq: null,
  setEnterCwdReq: (p) => set({ enterCwdReq: p }),
  runningScripts: {},
  setRunningScript: (wsId, tabId) =>
    set((s) => {
      const next = { ...s.runningScripts };
      if (tabId) next[wsId] = tabId;
      else delete next[wsId];
      return { runningScripts: next };
    }),
  liveSessions: {},
  setLiveSession: (agent, sessionId, tabId) =>
    set((s) => {
      const next = { ...s.liveSessions };
      const key = sessionRuntimeKey(agent, sessionId);
      if (tabId) next[key] = tabId;
      else delete next[key];
      return { liveSessions: next };
    }),
  focusTabId: null,
  focusTab: (tabId) => set({ focusTabId: tabId }),
  sessionsQuery: null,
  openSessionReq: null,
  setSessionsQuery: (q) => set({ sessionsQuery: q }),
  setOpenSessionReq: (r) => set({ openSessionReq: r }),
  skillDraftReq: null,
  setSkillDraftReq: (r) => set({ skillDraftReq: r }),
  digestJob: null,
  startDigestJob: (src, force) => {
    const cur = get().digestJob;
    const same =
      cur &&
      cur.agent === src.agent &&
      cur.sessionId === src.sessionId &&
      cur.filePath === src.filePath;
    // 同一会话已有结果/正在跑：直接复用，不因 picker 重开而重复提炼（费 token 且慢）
    if (same && !force && cur.status !== "error") return;
    set({ digestJob: { ...src, status: "running", consumed: false } });
    invoke<HandoffBriefDto>("build_session_digest", {
      agent: src.agent,
      sessionId: src.sessionId,
      filePath: src.filePath,
      cwd: src.cwd,
      title: src.title,
      targetPath: null,
    })
      .then((brief) => {
        const j = get().digestJob;
        // 期间用户已发起另一会话的提炼：本次结果作废，不回写
        if (j && j.agent === src.agent && j.sessionId === src.sessionId)
          set({ digestJob: { ...j, status: "ready", brief } });
      })
      .catch((e) => {
        const j = get().digestJob;
        if (j && j.agent === src.agent && j.sessionId === src.sessionId)
          set({ digestJob: { ...j, status: "error", error: String(e) } });
      });
  },
  consumeDigestJob: () => {
    const j = get().digestJob;
    if (j) set({ digestJob: { ...j, consumed: true } });
  },
  digestOpenReq: null,
  setDigestOpenReq: (n) => set({ digestOpenReq: n }),
  artifactCheckReq: null,
  setArtifactCheckReq: (id) => set({ artifactCheckReq: id }),
  contextLabel: null,
  setContextLabel: (v) => set({ contextLabel: v }),
  selectProjectReq: null,
  helpViewReq: null,
  setHelpViewReq: (path) => set({ helpViewReq: path }),
  setSelectProjectReq: (path) => set({ selectProjectReq: path }),
  sessionScopeReq: null,
  setSessionScopeReq: (r) => set({ sessionScopeReq: r }),
  taskCards: {},
  loadTaskCards: async (projectRoot) => {
    const cards = await invoke<TaskCardDto[]>("list_task_cards", {
      projectRoot,
    });
    set((s) => ({ taskCards: { ...s.taskCards, [projectRoot]: cards } }));
    return cards;
  },
  createCard: async (projectRoot, name, step, kind) => {
    const card = await invoke<TaskCardDto>("create_task_card", {
      projectRoot,
      name,
      step,
      kind: kind ?? null,
    });
    await get().loadTaskCards(projectRoot);
    return card;
  },
  renameCard: async (projectRoot, taskId, newName) => {
    await invoke("rename_task_card", { projectRoot, taskId, newName });
    await get().loadTaskCards(projectRoot);
  },
  deleteCard: async (projectRoot, taskId) => {
    await invoke("delete_task_card", { projectRoot, taskId });
    await get().loadTaskCards(projectRoot);
    // 后端已清掉会话的 task_id：刷新会话列表让对话页 chip/分组即时消失
    await get().loadSessions();
  },
  assignSessionTask: async (agent, sessionId, taskId) => {
    await invoke("assign_session_task", { agent, sessionId, taskId });
    await get().loadSessions();
  },
  profileIssues: {},
  setProfileIssue: (id, issue) =>
    set((s) => {
      const next = { ...s.profileIssues };
      if (issue) next[id] = issue;
      else delete next[id];
      return { profileIssues: next };
    }),
  settings: null,
  loadSettings: async () => {
    const s = await invoke<AppSettings>("get_settings");
    set({ settings: s });
    applyTheme(s.theme);
  },
  updateSettings: async (patch) => {
    const s = await invoke<AppSettings>("update_settings", { patch });
    set({ settings: s });
    applyTheme(s.theme);
  },

  appUpdate: null,
  checkAppUpdate: async () => {
    try {
      set({ appUpdate: await check() });
    } catch {
      // 静默：dev 模式/无网络/未发布 latest.json 时检查失败不打扰
    }
  },

  loadAll: async () => {
    const [profiles, agents] = await Promise.all([
      invoke<Profile[]>("list_profiles"),
      invoke<DetectResult[]>("detect_agents"),
    ]);
    set({ profiles, agents });
  },

  loadSessions: async () => {
    const sessions = await invoke<SessionMetaDto[]>("list_sessions");
    set({ sessions });
    return sessions;
  },

  saveProfile: async (id, input) => {
    if (id) {
      await invoke("update_profile", { id, input });
    } else {
      await invoke("create_profile", { input });
    }
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
  },

  removeProfile: async (id) => {
    await invoke("delete_profile", { id });
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
  },

  duplicateProfile: async (id) => {
    await invoke("duplicate_profile", { id });
    const profiles = await invoke<Profile[]>("list_profiles");
    set({ profiles });
  },
}));

export function useProfilesByAgent(agentId: string): Profile[] {
  return useAppStore((s) => s.profiles).filter((p) => p.agent === agentId);
}
