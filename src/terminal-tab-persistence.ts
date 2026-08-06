export const TERMINAL_TABS_STORAGE_KEY = "ccode.terminalTabs.v1";

const MAX_TABS = 24;
const AGENT_IDS = new Set(["claude-code", "codex", "gemini", "qwen", "opencode", "kimi", "codebuddy", "cursor"]);

export interface RecoverableTerminalTab {
  label: string;
  cwd: string;
  agentId: string;
  profileId: string;
  model: string;
  sessionId: string | null;
}

export interface RecoverableTerminalState {
  tabs: RecoverableTerminalTab[];
  activeIndex: number;
}

function textField(value: unknown, max: number, trim = true): string | null {
  if (typeof value !== "string") return null;
  const normalized = trim ? value.trim() : value;
  if (!normalized.trim()) return null;
  return normalized.slice(0, max);
}

function parseTab(value: unknown): RecoverableTerminalTab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Record<string, unknown>;
  const label = textField(tab.label, 256);
  const cwd = textField(tab.cwd, 4096, false);
  const agentId = textField(tab.agentId, 128);
  if (!label || !cwd || !agentId || !AGENT_IDS.has(agentId)) return null;
  return {
    label,
    cwd,
    agentId,
    profileId: textField(tab.profileId, 256) ?? "",
    model: textField(tab.model, 512) ?? "",
    sessionId: textField(tab.sessionId, 256),
  };
}

/** 只接受当前版本并逐字段白名单化；损坏或未来版本直接回落为空状态。 */
export function parseRecoverableTerminalState(raw: string | null): RecoverableTerminalState {
  if (!raw) return { tabs: [], activeIndex: 0 };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || value.version !== 1 || !Array.isArray(value.tabs)) {
      return { tabs: [], activeIndex: 0 };
    }
    const tabs = value.tabs.slice(0, MAX_TABS).map(parseTab).filter((tab) => tab !== null);
    const requested = typeof value.activeIndex === "number" ? Math.trunc(value.activeIndex) : 0;
    return {
      tabs,
      activeIndex: tabs.length > 0 ? Math.min(Math.max(requested, 0), tabs.length - 1) : 0,
    };
  } catch {
    return { tabs: [], activeIndex: 0 };
  }
}

/** 序列化时重新白名单化，调用方即使误传运行时字段也不会写入本地存储。 */
export function serializeRecoverableTerminalState(
  state: RecoverableTerminalState,
): string {
  const tabs = state.tabs.slice(0, MAX_TABS).map((tab) => ({
    label: tab.label.slice(0, 256),
    cwd: tab.cwd.slice(0, 4096),
    agentId: tab.agentId.slice(0, 128),
    profileId: tab.profileId.slice(0, 256),
    model: tab.model.slice(0, 512),
    sessionId: tab.sessionId?.slice(0, 256) ?? null,
  }));
  const activeIndex = tabs.length > 0
    ? Math.min(Math.max(Math.trunc(state.activeIndex), 0), tabs.length - 1)
    : 0;
  return JSON.stringify({ version: 1, tabs, activeIndex });
}
