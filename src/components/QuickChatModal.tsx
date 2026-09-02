import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Checkbox, primaryActionClass, secondaryActionClass, fieldClass } from "./PageFrame";
import { useAppStore } from "../store";
import { AGENTS, type SessionMetaDto } from "../types";
import { agentBrandBadgeStyle } from "../agent-colors";
import { relTime } from "../rel-time";
import { IS_WINDOWS } from "../hotkeys";
import { abbrevHome } from "../path-utils";
import {
  pickQuickChatHistory,
  sessionDisplayTitle,
} from "../quick-chat";

const SCRATCH_PLACEHOLDER = "~/ccode/scratch";

const LAST_KEY = "ccode.quickChat";
/** 勾选后侧栏「快速开聊」仍打开弹层。未勾且记住过选择 = 侧栏直达。⌘K 永远开弹层。 */
const ASK_KEY = "ccode.quickChatAlwaysAsk";
/** 旧键：1 = 下次跳过询问。仅作迁移，不再写入。 */
const SKIP_KEY = "ccode.quickChatSkip";

type Remembered = { agentId?: string; profileId?: string; cwd?: string };

function loadRemembered(): Remembered {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Remembered) : {};
  } catch {
    return {};
  }
}

export function quickChatAlwaysAsk(): boolean {
  try {
    const v = localStorage.getItem(ASK_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return localStorage.getItem(SKIP_KEY) === "0";
  } catch {
    return false;
  }
}

export function quickChatSkipEnabled(): boolean {
  if (quickChatAlwaysAsk()) return false;
  return Boolean(loadRemembered().agentId);
}

/** 跳过弹层的直接开聊：按上次选择落终端。返回 false = 没有可用的记住选择，调用方退回弹层 */
export async function launchQuickChatDirect(): Promise<boolean> {
  const r = loadRemembered();
  if (!r.agentId) return false;
  const { profiles, setPendingTerminal, setPage } = useAppStore.getState();
  const agentProfiles = profiles.filter((p) => p.agent === r.agentId);
  // 记住的配置可能已删除：落到该 agent 的第一个可用配置，没有就只预填不启动
  const profileId = agentProfiles.some((p) => p.id === r.profileId)
    ? r.profileId!
    : (agentProfiles[0]?.id ?? "");
  let cwd = r.cwd?.trim() ?? "";
  if (!cwd) {
    try {
      cwd = await invoke<string>("ensure_scratch_dir");
    } catch {
      return false;
    }
  }
  const agentLabel = AGENTS.find((a) => a.id === r.agentId)?.label ?? r.agentId;
  setPendingTerminal({
    cwd,
    extraEnv: {},
    title: `随手聊 · ${agentLabel}`,
    agentId: r.agentId,
    profileId: profileId || undefined,
    autoStart: !!profileId,
    clean: true,
    // 同一套选择的重复开聊切回已有标签，不堆新标签
    reuseKey: `quickchat:${r.agentId}:${profileId}:${cwd}`,
  });
  setPage("terminal");
  return true;
}

/** 恢复一条历史会话进终端（弹层「最近对话」行与侧栏右键菜单共用）：不开新会话。
    cwd 用会话原目录——worktree 会话的 projectPath 已归并回真实仓库（展示层另有工作区标注）。
    reuseKey 按会话 id：同一对话重复点切回同一标签；终端页消费处另有 cwd 活标签兜底
    （进程活着时不重复 resume，防 active writer 冲突） */
export function resumeSessionInTerminal(s: SessionMetaDto): void {
  const { setPendingTerminal, setPage } = useAppStore.getState();
  setPendingTerminal({
    cwd: s.projectPath,
    extraEnv: {},
    title: sessionDisplayTitle(s),
    resume: { agentId: s.agent, sessionId: s.sessionId },
    reuseKey: `resume:${s.agent}:${s.sessionId}`,
  });
  setPage("terminal");
}

/**
 * 「快速开聊」弹层：不绑项目地开一个终端标签。
 *
 * 刻意不做的事（与一键开步划清界限）：不建项目、不建工作区、不写 `.ccode`、
 * 不注册、不选模板、不落 TASK.md。默认落脚 `~/ccode/scratch`（后端 ensure_scratch_dir 创建，
 * 不 git init）——改动面板对它显示「不是 git 仓库」是预期行为。
 * 聊出东西了再从终端标签 ⋯「转为项目…」转正，会话历史跟着 cwd 走、自动归到新项目下。
 *
 * 下半是「继续上次」（只列 ~/ccode/scratch）。侧栏记住选择后直达；勾「每次都先问我」才每次开弹层。
 * ⌘K / 工作台页头永远开弹层。
 */
export default function QuickChatModal({ onClose }: { onClose: () => void }) {
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  const remembered = useMemo(loadRemembered, []);
  const sessions = useAppStore((s) => s.sessions);
  const projectPaths = useAppStore((s) => s.projectPaths);
  const liveSessions = useAppStore((s) => s.liveSessions);
  // 随手聊历史用启动时已进 store 的会话列表现算，打开弹层不再 round-trip
  const recent = useMemo(
    () =>
      pickQuickChatHistory(
        sessions,
        projectPaths,
        liveSessions,
        IS_WINDOWS,
      ),
    [sessions, projectPaths, liveSessions],
  );
  const latest = recent[0] ?? null;
  const older = recent.slice(1);
  // 已检测到的 agent 排在前面：没装的排后面并标注，不直接隐藏（用户可能刚装完还没重新检测）
  const installed = useMemo(
    () => new Set(agents.filter((a) => a.binaryPath).map((a) => a.id)),
    [agents],
  );
  const agentOptions = useMemo(
    () =>
      [...AGENTS].sort(
        (a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)),
      ),
    [installed],
  );

  const [agentId, setAgentId] = useState(
    () => remembered.agentId ?? agentOptions[0]?.id ?? "claude-code",
  );
  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [profileId, setProfileId] = useState(() => remembered.profileId ?? "");
  const [cwd, setCwd] = useState(
    () => remembered.cwd?.trim() || SCRATCH_PLACEHOLDER,
  );
  const [homeDir, setHomeDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alwaysAsk, setAlwaysAsk] = useState(quickChatAlwaysAsk);
  const [starting, setStarting] = useState(false);

  // 换 agent 时把配置落到该 agent 的可用项（记住的那个可能属于别的 agent）
  useEffect(() => {
    if (!agentProfiles.some((p) => p.id === profileId))
      setProfileId(agentProfiles[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles]);

  useEffect(() => {
    let stale = false;
    invoke<string>("home_dir")
      .then((h) => {
        if (!stale) setHomeDir(h);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  const agentLabel =
    AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  function expandCwd(raw: string, home: string): string {
    const t = raw.trim();
    if (t === "~") return home || t;
    if ((t.startsWith("~/") || t.startsWith("~\\")) && home)
      return `${home}${t.slice(1)}`;
    return t;
  }

  function isScratchPlaceholder(raw: string, home: string): boolean {
    const t = raw.trim();
    if (t === SCRATCH_PLACEHOLDER || t === "~\\ccode\\scratch") return true;
    if (!home) return false;
    return t === `${home}/ccode/scratch` || t === `${home}\\ccode\\scratch`;
  }

  async function start() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      let home = homeDir;
      const raw = cwd.trim();
      if ((raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) && !home) {
        home = await invoke<string>("home_dir");
        setHomeDir(home);
      }
      let resolvedCwd = expandCwd(raw, home);
      if (!resolvedCwd || isScratchPlaceholder(raw, home) || isScratchPlaceholder(resolvedCwd, home)) {
        resolvedCwd = await invoke<string>("ensure_scratch_dir");
      }
      if (!resolvedCwd) {
        setError("还没有确定开聊目录");
        return;
      }
      try {
        localStorage.setItem(
          LAST_KEY,
          JSON.stringify({ agentId, profileId, cwd: resolvedCwd }),
        );
        localStorage.setItem(ASK_KEY, alwaysAsk ? "1" : "0");
        localStorage.removeItem(SKIP_KEY);
      } catch {
        /* 隐私模式写不进就只用本次 */
      }
      setPendingTerminal({
        cwd: resolvedCwd,
        extraEnv: {},
        title: `随手聊 · ${agentLabel}`,
        agentId,
        profileId: profileId || undefined,
        autoStart: !!profileId,
        clean: true,
        reuseKey: `quickchat:${agentId}:${profileId}:${resolvedCwd}`,
      });
      setPage("terminal");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  /** 点「最近对话」行：resume 进终端（模块级 resumeSessionInTerminal 与侧栏右键菜单共用） */
  function resumeSession(s: SessionMetaDto) {
    resumeSessionInTerminal(s);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 ccode-fade"
      onClick={onClose}
    >
      <div
        className="w-[26rem] rounded-lg border border-field p-4 ccode-float-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-sm font-medium text-l1">快速开聊</h2>
        <p className="mb-3 text-micro text-l4">
          不建项目，直接开个终端聊。
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">Agent</span>
          <select
            className={fieldClass}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {installed.has(a.id) ? "" : "（未检测到）"}
              </option>
            ))}
          </select>
        </label>

        <label className="mb-2 block">
          <span className="mb-1 block text-xs text-l3">配置</span>
          <select
            className={fieldClass}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            {agentProfiles.length === 0 ? (
              <option value="">该 agent 还没有配置</option>
            ) : (
              agentProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-l3">目录</span>
          <input
            className={`${fieldClass} font-mono text-xs`}
            value={homeDir ? abbrevHome(cwd, homeDir, IS_WINDOWS) : cwd}
            onChange={(e) => {
              const v = e.target.value;
              if ((v.startsWith("~/") || v === "~") && homeDir)
                setCwd(v === "~" ? homeDir : `${homeDir}${v.slice(1)}`);
              else setCwd(v);
            }}
            placeholder={SCRATCH_PLACEHOLDER}
          />
        </label>

        {error && <p className="mb-2 text-xs text-err-text">{error}</p>}

        <Checkbox
          className="mb-3 text-xs text-l3"
          checked={alwaysAsk}
          onChange={setAlwaysAsk}
          label="每次都先问我"
        />

        <div className="flex items-center justify-end gap-2">
          <button type="button" className={secondaryActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className={primaryActionClass}
            disabled={!cwd.trim() || starting}
            autoFocus
          >
            开聊
          </button>
        </div>
        </form>

        {recent.length > 0 && (
          <div className="mt-4 border-t border-hairline pt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-l3">继续上次</span>
              <button
                type="button"
                className="text-micro text-l4 hover:text-l2"
                onClick={() => {
                  setPage("sessions");
                  onClose();
                }}
              >
                查看全部 →
              </button>
            </div>
            {latest && (
              <button
                type="button"
                onClick={() => resumeSession(latest)}
                title={`${sessionDisplayTitle(latest)}\n点按恢复该对话`}
                className="mb-1 flex h-8 w-full items-center gap-2 rounded-md border border-field bg-strip px-2.5 text-left text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
              >
                <span
                  className="shrink-0 rounded-sm px-1 py-0.5 text-micro"
                  style={agentBrandBadgeStyle(latest.agent)}
                >
                  {AGENTS.find((a) => a.id === latest.agent)?.label ?? latest.agent}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {sessionDisplayTitle(latest)}
                </span>
                <span className="shrink-0 text-micro text-l4">
                  {relTime(latest.updatedAt)}
                </span>
              </button>
            )}
            {older.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-auto">
              {older.map((s) => (
                <li key={`${s.agent}:${s.sessionId}`}>
                  <button
                    type="button"
                    onClick={() => resumeSession(s)}
                    title={`${sessionDisplayTitle(s)}\n${AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent} · ${s.projectPath}\n点按恢复该对话`}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <span
                      className="shrink-0 rounded-sm px-1 py-0.5 text-micro"
                      style={agentBrandBadgeStyle(s.agent)}
                    >
                      {AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-l1">
                      {sessionDisplayTitle(s)}
                    </span>
                    <span className="shrink-0 text-micro text-l4">
                      {relTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
