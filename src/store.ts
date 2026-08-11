import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { THEMES } from "./themes";
import type { RunOverviewInput } from "./run-overview";
import type {
  DetectResult,
  Profile,
  ProfileInput,
  RepoDto,
  SessionMetaDto,
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
  terminalPalette?: string; // dark-plus | solarized | one-dark | catppuccin
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
  /** 对话页「⇗ 外部恢复」的终端应用；auto/undefined = 按优先级探测 */
  externalTerminal?: string;
  /** 精确注意力标记（Claude Code hooks，写 ~/.claude/settings.json，默认关） */
  claudeHooksAttention?: boolean;
  /** 快捷键绑定（"mod+shift+k" 格式，mod=⌘/Ctrl；空串 = 禁用） */
  hotkeyPalette?: string;
  hotkeyHideChrome?: string;
  /** ⌘1–⌘8 页切整组总开关（关 = 全部页切绑定不生效） */
  hotkeyPageSwitch?: boolean;
  /** 页切逐页绑定：键 = 页面 id（hotkeys.ts PAGE_HOTKEY_DEFS），值 = 组合串；
      键缺失 = 该页用默认绑定（mod+1..mod+8） */
  hotkeyPages?: Record<string, string>;
}

/** 运行时切主题：Tailwind v4 @theme 的工具类引用 CSS 变量，覆盖 dataset.theme 即生效；
 *  同时同步原生窗口外观——原生 <select> 下拉/滚动条按 NSWindow appearance 渲染，
 *  只改 CSS 变量时深色主题下弹出的仍是系统浅色列表 */
export function applyTheme(id: string) {
  const theme = id || "midnight";
  document.documentElement.dataset.theme = theme;
  const light = THEMES.some((t) => t.id === theme && "light" in t && t.light);
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
  resume?: { agentId: string; sessionId: string };
  /** 指定启动配置（未给则按 ccode.lastProfile → 该 agent 首个配置兜底） */
  autoLaunchProfileId?: string;
  /** 预填启动栏（工作区记住上次配置） */
  agentId?: string;
  profileId?: string;
  model?: string;
  /** 一键开步预填的首条指令：启动时注入 CLI，启动成功后清除（一次性） */
  initialPrompt?: string;
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
  action:
    | {
        type: "review";
        worktreePath: string;
        intent?: "pr" | "archive" | "resolve-conflict";
      }
    | { type: "tab"; tabId: string }
    | { type: "session"; agent: string; sessionId: string };
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
  } else {
    s.setOpenSessionReq({
      agent: item.action.agent,
      sessionId: item.action.sessionId,
    });
    s.setPage("sessions");
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
  /** 一次性「跳终端页并激活标签」请求（首页待办点击发起），终端页可见时消费并清空 */
  focusTabReq: string | null;
  setFocusTabReq: (tabId: string | null) => void;
  /** 工作区页资源面板「查看」/ 步骤产物 → 终端页预览的交接（绝对路径，终端页消费并清空）；
      root 可选：文本预览的后端根约束（不给则回落活动标签 cwd） */
  previewReq: { path: string; name: string; root?: string } | null;
  setPreviewReq: (r: { path: string; name: string; root?: string } | null) => void;
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
  /** 应用设置（启动时加载；update 合并写回并即时应用主题） */
  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** 应用自更新：check() 命中的可用更新（null=已是最新/未检查完/检查失败） */
  appUpdate: Update | null;
  /** 启动时静默检查应用更新；失败（无网络/dev 模式）吞掉不打扰 */
  checkAppUpdate: () => Promise<void>;
  loadAll: () => Promise<void>;
  /** 拉取全部六个 agent 的会话元数据，返回最新列表供轮询比对 */
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
  focusTabReq: null,
  setFocusTabReq: (tabId) => set({ focusTabReq: tabId }),
  previewReq: null,
  setPreviewReq: (r) => set({ previewReq: r }),
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
