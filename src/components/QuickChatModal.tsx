import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { primaryActionClass, secondaryActionClass, fieldClass } from "./PageFrame";
import { useAppStore } from "../store";
import { AGENTS } from "../types";

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
  });
  setPage("terminal");
  return true;
}

/**
 * 「快速开聊」弹层：不绑项目地开一个终端标签。
 *
 * 刻意不做的事（与一键开步划清界限）：不建项目、不建工作区、不写 `.ccode`、
 * 不注册、不选模板、不落 TASK.md。默认落脚 `~/ccode/scratch`（后端 ensure_scratch_dir 创建，
 * 不 git init）——改动面板对它显示「不是 git 仓库」是预期行为。
 * 聊出东西了再从终端标签 ⋯「转为项目…」转正，会话历史跟着 cwd 走、自动归到新项目下。
 */
export default function QuickChatModal({ onClose }: { onClose: () => void }) {
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  const remembered = useMemo(loadRemembered, []);
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
    if (!cwd.trim()) {
      setError("还没有确定开聊目录");
      return;
    }
    try {
      localStorage.setItem(
        LAST_KEY,
        JSON.stringify({ agentId, profileId, cwd }),
      );
      localStorage.setItem(SKIP_KEY, skipNext ? "1" : "0");
    } catch {
      /* 隐私模式写不进就只用本次 */
    }
    setPendingTerminal({
      cwd: cwd.trim(),
      extraEnv: {},
      title: `随手聊 · ${agentLabel}`,
      agentId,
      profileId: profileId || undefined,
      // 弹层里已经确认过 agent/配置/目录，落到终端页不该再要一次「启动」；
      // 没有可用配置时 TerminalView 会自动降级为只预填
      autoStart: !!profileId,
      // 随手聊没有项目上下文：收起工作树与右栏，落地就是一个干净终端
      clean: true,
    });
    setPage("terminal");
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
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="~/ccode/scratch"
          />
        </label>

        {error && <p className="mb-2 text-xs text-err-text">{error}</p>}

        {/* 跳过弹层：勾选后下次点侧栏「快速开聊」按这套选择直接落终端；
            ⌘K 里的「快速开聊」永远打开本弹层，留作调整口 */}
        <label className="mb-3 flex items-center gap-2 text-xs text-l3">
          <input
            type="checkbox"
            className="size-3.5 accent-[var(--color-cta)]"
            checked={skipNext}
            onChange={(e) => setSkipNext(e.target.checked)}
          />
          下次直接开聊，不再询问（要调整就从 ⌘K 命令面板进）
        </label>

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
      </div>
    </div>
  );
}
