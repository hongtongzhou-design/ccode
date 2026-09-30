import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import { ChevronDown } from "lucide-react";
import {
  Checkbox,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { sessionRuntimeKey, useAppStore } from "../store";
import { AGENTS, type RunDto, type SessionMetaDto } from "../types";
import { agentBrand, agentBrandBadgeStyle } from "../agent-colors";
import { relTime } from "../rel-time";
import { IS_WINDOWS } from "../hotkeys";
import { Modal } from "./Modal";
import {
  pickQuickChatHistory,
  pickRememberedProfileId,
  profileCanAutoStart,
  sessionDisplayTitle,
} from "../quick-chat";

const SCRATCH_PLACEHOLDER = "~/ccode/scratch";

/** 控制台三档槽位：同一时刻只展开一格，其余两格收成一行读数。 */
type SlotId = "agent" | "link" | "dir";
const SLOT_ORDER: SlotId[] = ["agent", "link", "dir"];

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
  const { profiles, settings, setPendingTerminal, setPage } =
    useAppStore.getState();
  const agentProfiles = profiles.filter((p) => p.agent === r.agentId);
  const hidden = new Set(settings?.hiddenProfiles ?? []);
  const usable = agentProfiles.filter((p) =>
    profileCanAutoStart(p, hidden.has(p.id)),
  );
  // 记住的配置可能已删除/停用/失效：只在原配置仍可启动时直达，
  // 否则退回弹层，让用户看见并修正连接。不改用同 Agent 另一条。
  const profileId = pickRememberedProfileId(
    r.profileId,
    usable.map((p) => p.id),
  );
  if (!profileId) return false;
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

/** 恢复一条历史会话进终端（弹层「最近对话」行、侧栏右键、项目区「继续」共用）：不开新会话。
    cwd 用会话原目录——worktree 会话的 projectPath 已归并回真实仓库（展示层另有工作区标注）。
    终端里已经在跑这条会话时只切过去，不重复 resume。
    reuseKey 按会话 id：同一对话重复点切回同一标签；终端页消费处另有 runId/会话身份兜底
    （进程活着时不重复 resume，防 active writer 冲突）。
    Run 身份（runId/taskId/profileId）先查齐再一次性派发——先派发再补写会被终端页
    即时消费掉，补写条件不再成立，同一会话分裂成新 Run */
export function resumeSessionInTerminal(
  s: SessionMetaDto,
  opts?: { preferredProfileId?: string | null },
): void {
  const { setPendingTerminal, setPage, liveSessions, focusTab } =
    useAppStore.getState();
  const liveTab = liveSessions[sessionRuntimeKey(s.agent, s.sessionId)];
  if (liveTab) {
    setPage("terminal");
    focusTab(liveTab);
    return;
  }
  const preferred = opts?.preferredProfileId?.trim() || "";
  void (async () => {
    const run = await invoke<RunDto | null>("run_find", {
      reuseKey: null,
      agent: s.agent,
      sessionId: s.sessionId,
    }).catch(() => null);
    setPendingTerminal({
      cwd: s.cwd ?? s.projectPath,
      extraEnv: {},
      title: sessionDisplayTitle(s),
      resume: {
        agentId: s.agent,
        sessionId: s.sessionId,
        provider: s.provider,
      },
      reuseKey: `resume:${s.agent}:${s.sessionId}`,
      runId: run?.id,
      taskId: run?.taskId || undefined,
      // 项目绑了这家配置就预填它；Codex 渠道和上次不同时启动栏仍显示绑定、不自动跑。
      // 没绑才回落原 Run 的配置。
      profileId: preferred ? undefined : (run?.profileId ?? undefined),
      autoLaunchProfileId: preferred || undefined,
    });
    setPage("terminal");
  })();
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
  const setSessionsScratchReq = useAppStore((s) => s.setSessionsScratchReq);

  const remembered = useMemo(loadRemembered, []);
  const sessions = useAppStore((s) => s.sessions);
  const projectPaths = useAppStore((s) => s.projectPaths);
  const liveSessions = useAppStore((s) => s.liveSessions);
  // 随手聊历史用启动时已进 store 的会话列表现算，打开弹层不再 round-trip
  const recent = useMemo(() => {
    try {
      const rows = pickQuickChatHistory(
        sessions ?? [],
        projectPaths ?? [],
        liveSessions ?? {},
        IS_WINDOWS,
      );
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }, [sessions, projectPaths, liveSessions]);

  // 已检测到的 agent 排在前面：没装的排后面并标注，不直接隐藏（用户可能刚装完还没重新检测）
  const installed = useMemo(
    () => new Set((agents ?? []).filter((a) => a.binaryPath).map((a) => a.id)),
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
  const agentProfiles = (profiles ?? []).filter((p) => p.agent === agentId);
  const [profileId, setProfileId] = useState(() => remembered.profileId ?? "");
  const [cwd, setCwd] = useState(
    () => remembered.cwd?.trim() || SCRATCH_PLACEHOLDER,
  );
  const [homeDir, setHomeDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alwaysAsk, setAlwaysAsk] = useState(quickChatAlwaysAsk);
  const [starting, setStarting] = useState(false);
  // 记住过选择的人开窗即是三行读数，回车就能开聊；第一次用才把 AGENT 展开。
  const [slot, setSlot] = useState<SlotId | null>(() =>
    remembered.agentId ? null : "agent",
  );
  const panelRef = useRef<HTMLFormElement>(null);

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
        if (stale) return;
        setHomeDir(h);
        setCwd((c) => (c === SCRATCH_PLACEHOLDER ? `${h}/ccode/scratch` : c));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  const agentLabel =
    AGENTS.find((a) => a.id === agentId)?.label ?? agentId;
  const activeProfile =
    agentProfiles.find((p) => p.id === profileId) ?? agentProfiles[0];
  const linkLabel = activeProfile?.name ?? "这个 Agent 还没有连接";
  const linkCode = activeProfile
    ? String(agentProfiles.findIndex((p) => p.id === activeProfile.id) + 1).padStart(2, "0")
    : "--";
  const directoryOptions = useMemo(() => {
    const scratch = homeDir ? `${homeDir}/ccode/scratch` : SCRATCH_PLACEHOLDER;
    const rows = [
      { value: scratch, label: "随手聊", code: "SC" },
      ...(projectPaths ?? []).slice(0, 6).map((path) => ({
        value: path,
        label: path.split(/[\\/]/).filter(Boolean).pop() || path,
        code: "PJ",
      })),
    ];
    if (cwd && !rows.some((row) => row.value === cwd)) {
      rows.push({
        value: cwd,
        label: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd,
        code: "PK",
      });
    }
    rows.push({ value: "pick", label: "另选文件夹", code: "+" });
    return rows;
  }, [cwd, homeDir, projectPaths]);
  const directoryValue = directoryOptions.some((row) => row.value === cwd) ? cwd : "pick";
  const dirRow = directoryOptions.find((row) => row.value === cwd);
  const dirLabel = dirRow?.label ?? cwd;
  const dirCode = dirRow?.code ?? "PK";

  async function pickDirectory() {
    const picked = await openDirectory({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) setCwd(picked);
  }

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
      // 行内读数用 activeProfile 兜底，提交也必须用同一个值——否则首帧
      // profileId 还停在换 Agent 前的旧值，显示的配置和真正启动的不是同一条。
      const launchProfileId = activeProfile?.id ?? "";
      try {
        localStorage.setItem(
          LAST_KEY,
          JSON.stringify({ agentId, profileId: launchProfileId, cwd: resolvedCwd }),
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
        profileId: launchProfileId || undefined,
        autoStart: !!launchProfileId,
        clean: true,
        reuseKey: `quickchat:${agentId}:${launchProfileId}:${resolvedCwd}`,
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

  function focusSlot(id: SlotId) {
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(`[data-slot-head="${id}"]`)
        ?.focus();
    });
  }

  function toggleSlot(id: SlotId) {
    setSlot((cur) => (cur === id ? null : id));
  }

  /** 选完一档自动进下一档，最后一档选完收起并把焦点交给「开聊」：一路点下去即可 */
  function advance(from: SlotId) {
    const next = SLOT_ORDER[SLOT_ORDER.indexOf(from) + 1];
    if (next) {
      setSlot(next);
      focusSlot(next);
      return;
    }
    setSlot(null);
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('[type="submit"]')?.focus();
    });
  }

  /** 档位标题上 ↑/↓ 换档（不回绕），Enter/Space 展开收起走按钮自身 */
  function navSlot(from: SlotId, step: 1 | -1) {
    const next = SLOT_ORDER[SLOT_ORDER.indexOf(from) + step];
    if (!next) return;
    setSlot(next);
    focusSlot(next);
  }

  // 三档共用一套几何：档位标题行 + 展开区。当前档位的强调色随 agent 品牌走，
  // 目录档退回落款色——切 Agent 时整条控制台换色，这是「科幻感」的来源之一。
  const accent = agentBrand(agentId);
  const dirAccent = "var(--color-cta)";

  return (
    <Modal open title="快速开聊" description="不建项目，直接开个终端聊。" onClose={onClose} size="md">

        <form
          ref={panelRef}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
        <div className="mb-3 overflow-hidden rounded-lg border border-field">
          <ConsoleSlot
            id="agent"
            label="AGENT"
            tone={accent}
            open={slot === "agent"}
            onToggle={() => toggleSlot("agent")}
            onNav={(step) => navSlot("agent", step)}
            value={agentLabel}
            code={agentCode(agentId)}
          >
            <ConsoleCells
              tone={accent}
              value={agentId}
              onChange={(next) => {
                setAgentId(next);
                advance("agent");
              }}
              options={agentOptions.map((agent, index) => ({
                value: agent.id,
                label: agent.label,
                code: String(index + 1).padStart(2, "0"),
                dim: !installed.has(agent.id),
              }))}
            />
          </ConsoleSlot>

          <ConsoleSlot
            id="link"
            label="LINK"
            tone={accent}
            open={slot === "link"}
            onToggle={() => toggleSlot("link")}
            onNav={(step) => navSlot("link", step)}
            value={linkLabel}
            code={linkCode}
          >
            <ConsoleCells
              tone={accent}
              value={profileId}
              empty="这个 Agent 还没有连接"
              onChange={(next) => {
                setProfileId(next);
                advance("link");
              }}
              options={agentProfiles.map((profile, index) => ({
                value: profile.id,
                label: profile.name,
                code: String(index + 1).padStart(2, "0"),
              }))}
            />
          </ConsoleSlot>

          <ConsoleSlot
            id="dir"
            label="DIR"
            tone={dirAccent}
            open={slot === "dir"}
            onToggle={() => toggleSlot("dir")}
            onNav={(step) => navSlot("dir", step)}
            value={dirLabel}
            code={dirCode}
            sub={cwd}
          >
            <ConsoleCells
              tone={dirAccent}
              value={directoryValue}
              onChange={(next) => {
                if (next === "pick") {
                  void pickDirectory();
                  return;
                }
                setCwd(next);
                advance("dir");
              }}
              options={directoryOptions}
            />
          </ConsoleSlot>
        </div>

        {error && <p className="mb-2 text-xs text-err-text">{error}</p>}

        <div className="flex items-center gap-2">
          <Checkbox
            className="min-w-0 flex-1 text-xs text-l3"
            checked={alwaysAsk}
            onChange={setAlwaysAsk}
            label="下次仍显示此窗口"
          />
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
                  setSessionsScratchReq(true);
                  setPage("sessions");
                  onClose();
                }}
              >
                查看全部 →
              </button>
            </div>
            <ul className="max-h-44 space-y-0.5 overflow-auto">
              {recent.map((s) => (
                <li key={`${s.agent}:${s.sessionId}`}>
                  <button
                    type="button"
                    onClick={() => resumeSession(s)}
                    title={`${sessionDisplayTitle(s)}\n${AGENTS.find((a) => a.id === s.agent)?.label ?? s.agent} · ${s.projectPath}\n点按恢复该对话`}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-hover"
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
          </div>
        )}
    </Modal>
  );
}

/** agent 的两字代号：品牌名首两字（Claude Code → CL）。 */
function agentCode(id: string): string {
  const label = AGENTS.find((a) => a.id === id)?.label ?? id;
  return label.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "··";
}

/** 收起态的一行读数：档位标题 + 当前值 + 代号，展开时才换成选项网格。 */
function ConsoleSlot({
  id,
  label,
  tone,
  open,
  onToggle,
  onNav,
  value,
  code,
  sub,
  children,
}: {
  id: SlotId;
  label: string;
  tone: string;
  open: boolean;
  onToggle: () => void;
  onNav: (step: 1 | -1) => void;
  value: string;
  code: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        data-slot-head={id}
        aria-expanded={open}
        title={open ? "收起" : `切换 ${label}`}
        onClick={onToggle}
        onKeyDown={(event: ReactKeyboardEvent<HTMLButtonElement>) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onNav(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
        className={`flex h-9 w-full items-center gap-2.5 px-2.5 text-left transition-colors ${
          open ? "" : "hover:bg-hover"
        }`}
        style={open ? { background: "var(--color-raised)" } : undefined}
      >
        {/* 档位色条：展开时实心，收起时只留一截淡色，扫一眼就知道哪档是活的 */}
        <span
          aria-hidden="true"
          className="h-3.5 w-[2px] shrink-0 rounded-full transition-opacity"
          style={{ background: tone, opacity: open ? 1 : 0.4 }}
        />
        <span className="w-14 shrink-0 font-mono text-micro tracking-[0.16em] text-l4">
          {label}
        </span>
        {/* 代号格：等宽 + 淡色底，模仿仪表面板上的编号窗 */}
        <span
          className="grid h-4 w-6 shrink-0 place-items-center rounded-sm font-mono text-micro"
          style={{
            color: open ? tone : "var(--color-l3)",
            background: open
              ? `color-mix(in srgb, ${tone} 16%, transparent)`
              : "var(--color-inset)",
          }}
        >
          {code}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            open ? "text-l1" : "text-l2"
          }`}
        >
          {value}
        </span>
        {sub && !open && (
          <span className="hidden min-w-0 max-w-[45%] truncate font-mono text-micro text-l4 sm:block">
            {sub}
          </span>
        )}
        <ChevronDown
          size={13}
          strokeWidth={1.8}
          aria-hidden="true"
          className={`shrink-0 text-l4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="px-2.5 pb-2.5 pt-1">{children}</div>}
    </div>
  );
}

/** 展开态的选项格：等宽选项号 + 名称；选中用品牌色调字与淡底，不铺实心块。 */
function ConsoleCells({
  value,
  options,
  onChange,
  tone,
  empty,
}: {
  value: string;
  options: { value: string; label: string; code?: string; dim?: boolean }[];
  onChange: (value: string) => void;
  tone: string;
  empty?: string;
}) {
  if (options.length === 0) return <p className="px-1 py-1 text-xs text-l4">{empty}</p>;
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1"
      role="radiogroup"
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={
              option.dim
                ? "还没检测到"
                : option.value === "pick"
                  ? "打开文件夹"
                  : option.value
            }
            onClick={() => onChange(option.value)}
            className={`flex h-8 min-w-0 items-center gap-2 rounded-md border px-2 text-left transition-colors ${
              on
                ? "border-transparent"
                : option.dim
                  ? "border-transparent text-l4 hover:bg-hover"
                  : "border-transparent text-l2 hover:bg-hover hover:text-l1"
            }`}
            style={
              on
                ? {
                    color: tone,
                    background: `color-mix(in srgb, ${tone} 13%, transparent)`,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 45%, transparent)`,
                  }
                : undefined
            }
          >
            <span
              className="shrink-0 font-mono text-micro"
              style={{ color: on ? tone : "var(--color-l4)" }}
            >
              {option.code ?? "·"}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
