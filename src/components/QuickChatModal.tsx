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
  pickQuickChatSessions,
  sessionHomeLabel,
  sessionDisplayTitle,
} from "../quick-chat";

const LAST_KEY = "ccode.quickChat";
/** 「下次直接开聊」开关：勾选后侧栏「快速开聊」跳过弹层直接落终端（⌘K 入口永远开弹层，留作调整口） */
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

export function quickChatSkipEnabled(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === "1";
  } catch {
    return false;
  }
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
 * v3.93 起弹层下半带「最近对话」区（用户拍板：想继续之前聊的还要去对话页翻，太远）——
 * 点一条直接 resume 进终端（不开新会话）。勾了「下次直接开聊」的用户从 ⌘K 进弹层仍可见。
 */
export default function QuickChatModal({ onClose }: { onClose: () => void }) {
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  const remembered = useMemo(loadRemembered, []);
  // 最近对话（随手聊口径：不落工作区/已注册项目）：弹层每次打开拉一轮
  // （list_sessions 有 10s 扫描缓存，list_projects 是本地 db 读，都不重）
  const [recent, setRecent] = useState<SessionMetaDto[] | null>(null);
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const [all, projects] = await Promise.all([
          invoke<SessionMetaDto[]>("list_sessions"),
          invoke<{ path: string }[]>("list_projects"),
        ]);
        if (stale) return;
        setRecent(
          pickQuickChatSessions(
            all,
            projects.map((p) => p.path),
            undefined,
            IS_WINDOWS,
          ),
        );
      } catch {
        if (!stale) setRecent([]);
      }
    })();
    return () => {
      stale = true;
    };
  }, []);
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
  const [cwd, setCwd] = useState(remembered.cwd ?? "");
  const [homeDir, setHomeDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [skipNext, setSkipNext] = useState(quickChatSkipEnabled);

  // 换 agent 时把配置落到该 agent 的可用项（记住的那个可能属于别的 agent）
  useEffect(() => {
    if (!agentProfiles.some((p) => p.id === profileId))
      setProfileId(agentProfiles[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles]);

  // 目录缺省值：上次用过的优先，否则问后端要 ~/ccode/scratch（顺带创建）
  useEffect(() => {
    if (cwd) return;
    let stale = false;
    invoke<string>("home_dir")
      .then((h) => {
        if (!stale) setHomeDir(h);
      })
      .catch(() => {});
    invoke<string>("ensure_scratch_dir")
      .then((dir) => {
        if (!stale) setCwd(dir);
      })
      .catch((e) => {
        if (!stale) setError(String(e));
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentLabel =
    AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  function start() {
    const resolvedCwd = (() => {
      const raw = cwd.trim();
      if (raw === "~") return homeDir || raw;
      if ((raw.startsWith("~/") || raw.startsWith("~\\")) && homeDir)
        return `${homeDir}${raw.slice(1)}`;
      return raw;
    })();
    if (!resolvedCwd) {
      setError("还没有确定开聊目录");
      return;
    }
    try {
      localStorage.setItem(
        LAST_KEY,
        JSON.stringify({ agentId, profileId, cwd: resolvedCwd }),
      );
      localStorage.setItem(SKIP_KEY, skipNext ? "1" : "0");
    } catch {
      /* 隐私模式写不进就只用本次 */
    }
    setPendingTerminal({
      cwd: resolvedCwd,
      extraEnv: {},
      title: `随手聊 · ${agentLabel}`,
      agentId,
      profileId: profileId || undefined,
      // 弹层里已经确认过 agent/配置/目录，落到终端页不该再要一次「启动」；
      // 没有可用配置时 TerminalView 会自动降级为只预填
      autoStart: !!profileId,
      // 随手聊没有项目上下文：收起工作树与右栏，落地就是一个干净终端
      clean: true,
      // 同一套选择的重复开聊切回已有标签，不堆新标签
      reuseKey: `quickchat:${agentId}:${profileId}:${cwd.trim()}`,
    });
    setPage("terminal");
    onClose();
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
            placeholder="~/ccode/scratch"
          />
        </label>

        {error && <p className="mb-2 text-xs text-err-text">{error}</p>}

        {/* 跳过弹层：勾选后下次点侧栏「快速开聊」按这套选择直接落终端；
            ⌘K 里的「快速开聊」永远打开本弹层，留作调整口 */}
        <Checkbox
          className="mb-3 text-xs text-l3"
          checked={skipNext}
          onChange={setSkipNext}
          label="下次跳过询问"
        />

        <div className="flex items-center justify-end gap-2">
          <button type="button" className={secondaryActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={primaryActionClass}
            onClick={start}
            disabled={!cwd.trim()}
          >
            开聊
          </button>
        </div>

        {/* 随手聊历史（v3.93）：回到之前的散聊不用去对话页翻。只列随手聊会话
            （不落工作区/已注册项目）且可恢复的（排除归档/内部/源文件已删/进程活着的）；
            与侧栏「快速开聊」右键浮层同一口径；空列表时整区不渲染 */}
        {recent && recent.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs text-l3">随手聊历史</span>
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
            <ul className="max-h-52 space-y-0.5 overflow-auto">
              {recent.map((s) => (
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
                      {sessionHomeLabel(s)} · {relTime(s.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
