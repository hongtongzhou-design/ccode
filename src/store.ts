import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { DetectResult, Profile, ProfileInput, SessionMetaDto } from "./types";

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
}

interface AppState {
  profiles: Profile[];
  agents: DetectResult[];
  sessions: SessionMetaDto[];
  /** 当前页面（nav id），放 store 里让任意页面可跳转 */
  page: string;
  setPage: (p: string) => void;
  /** 待消费的终端启动请求；终端页可见时消费并清空 */
  pendingTerminal: PendingTerminal | null;
  setPendingTerminal: (p: PendingTerminal | null) => void;
  /** 运行中的 run 脚本：工作区 id → 终端标签 id（nonconcurrent 互斥） */
  runningScripts: Record<string, string>;
  setRunningScript: (wsId: string, tabId: string | null) => void;
  /** 终端里正在进行的会话：sessionId → 标签 id（会话页「进行中」标记 + 反向跳转） */
  liveSessions: Record<string, string>;
  setLiveSession: (sessionId: string, tabId: string | null) => void;
  /** 会话页 → 终端页的焦点跳转请求（终端页消费并清空） */
  focusTabId: string | null;
  focusTab: (tabId: string | null) => void;
  /** 工作区页 → 会话页的搜索词交接（会话页消费并清空） */
  sessionsQuery: string | null;
  setSessionsQuery: (q: string | null) => void;
  loadAll: () => Promise<void>;
  /** 拉取全部会话元数据（Claude Code + Codex），返回最新列表供轮询比对 */
  loadSessions: () => Promise<SessionMetaDto[]>;
  saveProfile: (id: string | null, input: ProfileInput) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  duplicateProfile: (id: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  profiles: [],
  agents: [],
  sessions: [],
  page: "profiles",
  setPage: (p) => set({ page: p }),
  pendingTerminal: null,
  setPendingTerminal: (p) => set({ pendingTerminal: p }),
  runningScripts: {},
  setRunningScript: (wsId, tabId) =>
    set((s) => {
      const next = { ...s.runningScripts };
      if (tabId) next[wsId] = tabId;
      else delete next[wsId];
      return { runningScripts: next };
    }),
  liveSessions: {},
  setLiveSession: (sessionId, tabId) =>
    set((s) => {
      const next = { ...s.liveSessions };
      if (tabId) next[sessionId] = tabId;
      else delete next[sessionId];
      return { liveSessions: next };
    }),
  focusTabId: null,
  focusTab: (tabId) => set({ focusTabId: tabId }),
  sessionsQuery: null,
  setSessionsQuery: (q) => set({ sessionsQuery: q }),

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
