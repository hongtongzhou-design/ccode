import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { DetectResult, Profile, ProfileInput, SessionMetaDto } from "./types";

/** 工作区页 → 终端页的交接：新开一个标签，预填 cwd + 注入 env（如端口段） */
export interface PendingTerminal {
  cwd: string;
  extraEnv: Record<string, string>;
  title?: string;
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
