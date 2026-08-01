import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import FilePreviewEditor from "../components/FilePreviewEditor";
import FileTree from "../components/FileTree";
import GitPanel from "../components/GitPanel";
import type { ChatMessageDto, SessionMetaDto } from "../types";

type PtyKind = "agent" | "shell";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 标签页状态：由 TerminalView 上报，标签条 / 运行中总览 / 工作树根目录都用它 */
interface TabStatus {
  title: string;
  /** 有存活 PTY（agent 或 shell） */
  alive: boolean;
  /** agent 正在运行（关闭前需要确认） */
  running: boolean;
  /** 当前接的是登录 shell（agent 退出回落或手动打开） */
  shell: boolean;
  agentId: string;
  model: string;
  cwd: string;
  /** 当前 PTY id（可见性门控用；无存活 PTY 时为 null） */
  ptyId: string | null;
  /** 会话尾部状态（P3c 注意力标记）；无联动/shell/已退出/未知时为 null */
  attention: "done" | "working" | "confirm" | null;
}

/** TerminalView 上报的会话联动数据（右侧「会话」页签渲染用） */
interface SessionLinkState {
  file: string | null;
  conv: ChatMessageDto[];
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** 四款深色主题对应的 xterm 底色/前景（取自 App.css 各主题调色板；调色板其余部分共享） */
const XTERM_BG_FG: Record<string, { background: string; foreground: string }> = {
  midnight: { background: "#11131a", foreground: "#aeb6c6" },
  terracotta: { background: "#2d2d2b", foreground: "#c9c9c4" },
  ayu: { background: "#10141c", foreground: "#bfbdb6" },
  mocha: { background: "#1e1e2e", foreground: "#aeb8dc" },
  neutral: { background: "#111111", foreground: "#c9c9c9" },
  dracula: { background: "#282a36", foreground: "#cfcfc9" },
  shadcn: { background: "#111827", foreground: "#b9b9c0" },
};

/** VS Code Dark+ 风格 16 色调色板（各主题共享，只换底/字色） */
function buildXtermTheme(themeId: string) {
  return {
    ...(XTERM_BG_FG[themeId] ?? XTERM_BG_FG.midnight),
    cursor: "#aeafad",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  };
}

/** 单个终端：独立持有 xterm 实例、PTY 引用和启动栏状态；隐藏时只 display:none，不杀进程 */
function TerminalView({
  visible,
  rightOpen,
  tabId,
  initialCwd,
  skipSeed,
  initialExtraEnv,
  initialTitle,
  initialAgentId,
  initialProfileId,
  initialModel,
  resumeSessionId,
  autoStart,
  prefillCommand,
  shellOnly,
  externalCwd,
  onConsumeExternalCwd,
  onStatus,
  onSessionUpdate,
  onOpenSessionPanel,
}: {
  visible: boolean;
  /** 右侧面板开关影响 xterm 可用宽度，变化时需要重新 fit */
  rightOpen: boolean;
  /** 本标签 id（liveSessions 登记用） */
  tabId: string;
  /** 不继承「上次启动」记录（兜底空标签） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建的标签：启动栏 cwd 预填为该目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（如 CCODE_PORT 端口段），launch 时注入 */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名），优先于 profile/agent 名 */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 首次可见时自动启动（会话恢复；有 profile 才启动，否则只预填） */
  autoStart?: boolean;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：挂载后自动开 shell 并执行 prefillCommand（不走 agent 启动流程） */
  shellOnly?: boolean;
  /** 最近项目「真进入」：把目标目录注入活动标签的启动栏（TerminalView 消费后清空） */
  externalCwd?: string | null;
  onConsumeExternalCwd?: () => void;
  onStatus: (s: TabStatus) => void;
  onSessionUpdate: (s: SessionLinkState) => void;
  onOpenSessionPanel: () => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const settings = useAppStore((s) => s.settings);
  // 终端创建 effect 依赖 [everVisible]，创建时参数经 ref 取最新设置
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 设置即时应用：字号与主题色随设置页修改实时生效（scrollback 只对新终端生效）
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.fontSize = settings.terminalFontSize;
    term.options.theme = buildXtermTheme(settings.theme);
  }, [settings]);
  // 记住上次启动选择（agent/profile/模型/目录），每个新标签以此为初始值（skipSeed 标签除外）
  const saved = skipSeed ? {} : (() => {
    try {
      return JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as Partial<{
        agentId: string;
        profileId: string;
        model: string;
        cwd: string;
      }>;
    } catch {
      return {};
    }
  })();
  const [agentId, setAgentId] = useState<string>(initialAgentId ?? saved.agentId ?? "claude-code");
  const [profileId, setProfileId] = useState(initialProfileId ?? saved.profileId ?? "");
  const [model, setModel] = useState(initialModel ?? saved.model ?? "");
  const [cwd, setCwd] = useState(initialCwd ?? saved.cwd ?? "~");
  const [running, setRunning] = useState(false); // agent 正在运行
  const [shellActive, setShellActive] = useState(false); // 当前接的是 shell
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 启动栏收缩：空闲时完整展示，启动成功后自动收成一行状态条（「修改」可重新展开）
  const [barExpanded, setBarExpanded] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyKindRef = useRef<PtyKind | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);

  // —— 会话联动（SessionLink）：轮询在本地，展示数据上报给页面级右侧面板 ——
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  const lastResumeRef = useRef<string | null>(null);
  const linkCtxRef = useRef<{
    agentId: string;
    cwd: string;
    hint: string | null;
    sinceIso: string;
    filePath: string | null;
    /** 锁定的会话 id（liveSessions 登记用） */
    sessionId: string | null;
  } | null>(null);
  const linkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const setLiveSession = useAppStore((s) => s.setLiveSession);

  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [skillCount, setSkillCount] = useState(0);

  // 当前 agent 已启用的技能数（技能页开关同步）
  useEffect(() => {
    invoke<number>("count_enabled_skills", { agent: agentId })
      .then(setSkillCount)
      .catch(() => setSkillCount(0));
  }, [agentId]);
  const selectedProfile = profiles.find((p) => p.id === profileId);

  // 向标签条上报标题/运行状态；值没变就不惊动父组件
  const title = initialTitle ?? selectedProfile?.name ?? agentLabel(agentId);
  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  const [attention, setAttention] = useState<TabStatus["attention"]>(null);
  const lastReportRef = useRef("");
  useEffect(() => {
    const s: TabStatus = {
      title,
      alive: running || shellActive,
      running,
      shell: shellActive,
      agentId,
      model,
      cwd,
      ptyId: activePtyId,
      // 注意力标记只在 agent 运行中且已联动会话时有意义
      attention: running && !shellActive && sessionFile ? attention : null,
    };
    const key = JSON.stringify(s);
    if (key !== lastReportRef.current) {
      lastReportRef.current = key;
      onStatus(s);
    }
  }, [title, running, shellActive, agentId, model, cwd, activePtyId, attention, sessionFile, onStatus]);

  // 会话联动数据镜像给页面级右侧面板
  useEffect(() => {
    onSessionUpdate({ file: sessionFile, conv });
  }, [sessionFile, conv, onSessionUpdate]);

  // 从工作树带入目录创建的标签：聚焦配置选择，选好即可启动
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (initialCwd) profileSelectRef.current?.focus();
  }, [initialCwd]);

  // 懒挂载：首次可见时才创建 xterm，未展示过的标签不占用终端资源
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);

  useEffect(() => {
    if (!everVisible) return;
    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
      fontSize: settingsRef.current?.terminalFontSize ?? 13,
      // 显示质感微调：字形加实、盒绘对齐、粗体增亮、平滑滚动（对比度保持默认）
      fontWeight: 500,
      fontWeightBold: 700,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 150,
      lineHeight: 1.25,
      letterSpacing: 0.2,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: settingsRef.current?.scrollback ?? 5000,
      theme: buildXtermTheme(settingsRef.current?.theme ?? "midnight"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    try {
      fit.fit();
    } catch {
      // 容器隐藏时 fit 会算不出尺寸，可见时再 fit
    }
    termRef.current = term;
    fitRef.current = fit;

    // WebGL 渲染（优化 3）：加载失败/上下文丢失时退回默认 DOM 渲染
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // GPU/驱动不支持 WebGL 时保持默认渲染器
    }

    const onWinResize = () => {
      try {
        fit.fit();
      } catch {}
    };
    window.addEventListener("resize", onWinResize);

    const subs = [
      term.onData((data) => {
        const id = ptyIdRef.current;
        if (id) invoke("pty_write", { ptyId: id, data }).catch(() => {});
      }),
      term.onResize(({ cols, rows }) => {
        const id = ptyIdRef.current;
        if (id) invoke("pty_resize", { ptyId: id, cols, rows }).catch(() => {});
      }),
    ];

    // 只在组件卸载（标签被关闭 / 应用退出）时清理 PTY；隐藏不触发
    return () => {
      window.removeEventListener("resize", onWinResize);
      subs.forEach((s) => s.dispose());
      stopLinkTimer();
      // 释放 liveSessions 登记（「进行中」标记随标签消失）
      const sid = linkCtxRef.current?.sessionId;
      if (sid) setLiveSession(sid, null);
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      ptyKindRef.current = null;
      if (id) invoke("pty_kill", { ptyId: id }).catch(() => {});
      unlistenRef.current.forEach((u) => u());
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everVisible]);

  // 标签从隐藏切回可见 / 右侧面板开关改变可用宽度时重新 fit（display:none 下尺寸为 0）
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
  }, [visible, rightOpen]);

  // 最近项目「真进入」：外部注入的 cwd 落地到启动栏（空闲时），状态上报后父级清空
  useEffect(() => {
    if (visible && externalCwd && !running) {
      setCwd(externalCwd);
      onConsumeExternalCwd?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, externalCwd, running]);

  // run 脚本标签：终端就绪后自动开 shell 并写入脚本命令（tty 会缓冲输入直到 shell 读取）。
  // 声明在终端创建 effect 之后，保证 attach 时 termRef 已就位
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!shellOnly || !visible || !everVisible || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void (async () => {
      try {
        const ptyId = await invoke<string>("shell_spawn", {
          cwd,
          extraEnv: initialExtraEnv ?? null,
        });
        await attach(ptyId, "shell", { reset: true });
        setExited(false);
        setShellActive(true);
        if (prefillCommand) {
          await invoke("pty_write", { ptyId, data: `${prefillCommand}\n` });
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, shellOnly]);

  // 会话恢复标签：首次可见且找得到配置时自动启动一次（找不到则只预填，由用户处理）
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || !visible || !everVisible || autoLaunchedRef.current) return;
    autoLaunchedRef.current = true;
    if (profiles.some((p) => p.id === profileId)) {
      void launch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, autoStart, profileId, profiles]);

  /** 把一个 PTY 接到 xterm 上；agent 退出时自动回落到 shell */
  async function attach(ptyId: string, kind: PtyKind, opts?: { reset?: boolean }) {
    const term = termRef.current!;
    if (opts?.reset) term.reset();
    unlistenRef.current.forEach((u) => u());
    ptyIdRef.current = ptyId;
    ptyKindRef.current = kind;
    setActivePtyId(ptyId);
    unlistenRef.current = [
      await listen<string>(`pty-output-${ptyId}`, (e) => term.write(e.payload)),
      await listen<number>(`pty-exit-${ptyId}`, () => {
        void onPtyExit(ptyId);
      }),
    ];
    try {
      fitRef.current?.fit();
    } catch {}
    await invoke("pty_resize", { ptyId, cols: term.cols, rows: term.rows }).catch(
      () => {},
    );
    term.focus();
  }

  async function onPtyExit(exitedId: string) {
    // 已被 launch/cleanup 切换到新 PTY，忽略这个过期的退出事件
    if (ptyIdRef.current !== exitedId) return;
    const kind = ptyKindRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    setActivePtyId(null);
    setRunning(false);
    setAttention(null); // agent 退出：清除注意力标记
    if (kind === "agent") {
      // 记录可恢复的会话 id（一键恢复按钮用）
      lastResumeRef.current = linkCtxRef.current?.sessionId ?? null;
      // agent 退出（含手动停止）→ 同一终端自动回落到登录 shell
      termRef.current?.write("\r\n\x1b[90m── agent 已结束（会话已保存，可一键恢复）── 当前为 shell ──\x1b[0m\r\n");
      try {
        const id = await invoke<string>("shell_spawn", {
          cwd,
          extraEnv: initialExtraEnv ?? null,
        });
        await attach(id, "shell");
        setShellActive(true);
      } catch (e) {
        setError(String(e));
        setExited(true);
      }
      void finalizeLink();
    } else {
      setShellActive(false);
      setExited(true);
    }
  }

  /** 彻底清理当前 PTY（用于重新启动前/手动开 shell 前）；先置空引用以抑制自动回落 */
  async function cleanupPty() {
    const id = ptyIdRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    if (id) await invoke("pty_kill", { ptyId: id }).catch(() => {});
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];
    resetLink();
  }

  function stopLinkTimer() {
    if (linkTimerRef.current) {
      clearInterval(linkTimerRef.current);
      linkTimerRef.current = null;
    }
  }

  /** 找当前 agent 进程对应的会话文件：有 hint 按 sessionId 精确匹配，否则按目录+启动时间兜底 */
  async function findSessionFile(): Promise<{ filePath: string; sessionId: string } | null> {
    const ctx = linkCtxRef.current;
    if (!ctx) return null;
    try {
      if (ctx.hint) {
        const list = await invoke<SessionMetaDto[]>("list_sessions");
        const hit = list.find((s) => s.agent === ctx.agentId && s.sessionId === ctx.hint);
        return hit ? { filePath: hit.filePath, sessionId: ctx.hint! } : null;
      }
      const meta = await invoke<SessionMetaDto | null>("find_session_for", {
        agent: ctx.agentId,
        cwd: ctx.cwd,
        sinceIso: ctx.sinceIso,
      });
      return meta ? { filePath: meta.filePath, sessionId: meta.sessionId } : null;
    } catch {
      return null;
    }
  }

  async function fetchConversation() {
    const ctx = linkCtxRef.current;
    if (!ctx?.filePath) return;
    try {
      const msgs = await invoke<ChatMessageDto[]>("get_session_conversation", {
        agent: ctx.agentId,
        filePath: ctx.filePath,
      });
      setConv(msgs);
    } catch {
      // 会话文件可能写到一半，下轮再试
    }
    // P3c：同一路径顺带轮询会话尾部状态（done/working/confirm/unknown）
    try {
      const state = await invoke<string>("session_tail_state", {
        agent: ctx.agentId,
        filePath: ctx.filePath,
      });
      setAttention(
        state === "done" || state === "working" || state === "confirm" ? state : null,
      );
    } catch {
      setAttention(null);
    }
  }

  /** 会话文件锁定：登记 liveSessions（会话页「进行中」+ 反向跳转） */
  function lockLink(filePath: string, sessionId: string) {
    const ctx = linkCtxRef.current;
    if (!ctx || ctx.filePath) return;
    ctx.filePath = filePath;
    ctx.sessionId = sessionId;
    setSessionFile(filePath);
    setLiveSession(sessionId, tabId);
  }

  async function linkTick() {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (!hit) return;
      lockLink(hit.filePath, hit.sessionId);
    }
    await fetchConversation();
  }

  function startLinkPolling() {
    stopLinkTimer();
    linkTimerRef.current = setInterval(() => void linkTick(), 3000);
    void linkTick();
  }

  /** agent 退出后停止轮询，最后再抓一次拿到完整对话 */
  async function finalizeLink() {
    stopLinkTimer();
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (hit) lockLink(hit.filePath, hit.sessionId);
    }
    await fetchConversation();
  }

  function resetLink() {
    stopLinkTimer();
    const sid = linkCtxRef.current?.sessionId;
    if (sid) setLiveSession(sid, null);
    linkCtxRef.current = null;
    setSessionFile(null);
    setConv([]);
    setAttention(null);
  }

  async function launch(resumeId?: string) {
    setError(null);
    await cleanupPty();
    try {
      const res = await invoke<{ ptyId: string; sessionHint: string | null }>(
        "pty_spawn",
        {
          agentId,
          profileId,
          cwd,
          model: model || null,
          // 工作区交接的附加 env（端口段），与 profile env 叠加
          extraEnv: initialExtraEnv ?? null,
          // 会话恢复（无则全新会话）
          resumeSessionId: resumeId ?? resumeSessionId ?? null,
        },
      );
      localStorage.setItem(
        "ccode.lastLaunch",
        JSON.stringify({ agentId, profileId, model, cwd }),
      );
      // 记住各 agent 上次使用的配置（会话恢复的兜底选择）
      localStorage.setItem(`ccode.lastProfile.${agentId}`, profileId);
      // 工作区记住上次配置（W3：worktree 目录下的启动）
      if (cwd.includes("/ccode/workspaces/")) {
        localStorage.setItem(
          `ccode.wsLast.${cwd}`,
          JSON.stringify({ agentId, profileId, model }),
        );
      }
      // SessionLink：记录启动上下文，开始轮询会话文件
      linkCtxRef.current = {
        agentId,
        cwd,
        hint: res.sessionHint,
        sinceIso: new Date().toISOString(),
        filePath: null,
        sessionId: null,
      };
      startLinkPolling();
      await attach(res.ptyId, "agent", { reset: true });
      setExited(false);
      setShellActive(false);
      setRunning(true);
      setBarExpanded(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openShell() {
    setError(null);
    await cleanupPty();
    try {
      const ptyId = await invoke<string>("shell_spawn", {
        cwd,
        extraEnv: initialExtraEnv ?? null,
      });
      await attach(ptyId, "shell", { reset: true });
      setExited(false);
      setShellActive(true);
      setBarExpanded(false);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 停止 agent：杀掉 PTY 后由退出事件自动回落到 shell */
  async function stop() {
    const id = ptyIdRef.current;
    if (id) await invoke("pty_kill", { ptyId: id }).catch(() => {});
  }

  const select =
    "rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

  return (
    <div className="flex h-full flex-col px-2 pt-1">
      {barExpanded ? (
        <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className={select}
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setProfileId("");
            setModel("");
          }}
          disabled={running}
        >
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {skillCount > 0 && (
          <span
            className="rounded bg-inset px-1.5 py-1 text-xs text-l3"
            title={`该 agent 已启用 ${skillCount} 个技能（技能页管理）`}
          >
            ◈ {skillCount} 技能
          </span>
        )}
        <select
          ref={profileSelectRef}
          className={select}
          value={profileId}
          onChange={(e) => {
            setProfileId(e.target.value);
            const prof = profiles.find((p) => p.id === e.target.value);
            setModel(prof?.models[0] ?? "");
          }}
          disabled={running}
        >
          <option value="" disabled>
            选择配置
          </option>
          {agentProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {selectedProfile && selectedProfile.models.length > 0 && (
          <select
            className={select}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            title="选择本次启动使用的模型"
          >
            {selectedProfile.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {initialExtraEnv && Object.keys(initialExtraEnv).length > 0 && (
          <span
            className="rounded bg-inset px-1.5 py-0.5 text-xs text-l3"
            title={`启动时注入：\n${Object.entries(initialExtraEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n")}`}
          >
            工作区 · 端口段已注入
          </span>
        )}
        <input
          className={`${select} w-64`}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="工作目录，如 ~/work/myproject"
          disabled={running}
        />
        {running ? (
          <button
            onClick={stop}
            className="rounded bg-err px-3 py-1.5 text-sm text-err-text hover:brightness-110"
          >
            停止
          </button>
        ) : (
          <>
            <button
              onClick={() => launch()}
              disabled={!profileId}
              className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
            >
              启动
            </button>
            <button
              onClick={openShell}
              className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
            >
              打开 Shell
            </button>
          </>
        )}
        <button
          onClick={onOpenSessionPanel}
          disabled={!running && !sessionFile}
          title="查看当前会话的结构化对话"
          className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5 disabled:opacity-50"
        >
          会话
        </button>
        {shellActive && !running && (
          <>
            <span className="text-sm text-l3">shell 模式</span>
            {lastResumeRef.current && (
              <button
                onClick={() => launch(lastResumeRef.current ?? undefined)}
                title="恢复到刚才的会话继续对话"
                className="rounded border border-field px-2 py-1 text-xs text-l2 hover:bg-white/5 hover:text-l1"
              >
                ⟳ 恢复会话
              </button>
            )}
          </>
        )}
        {exited && !running && !shellActive && (
          <span className="text-sm text-l3">进程已退出</span>
        )}
        {error && <span className="text-sm text-err-text">{error}</span>}
      </div>
      {agentProfiles.length === 0 && (
        <p className="mb-2 text-sm text-l3">
          该 agent 暂无配置，请先在「配置」页创建。
        </p>
      )}
      {autoStart && profileId && !profiles.some((p) => p.id === profileId) && (
        <p className="mb-2 text-sm text-l3">请先为该 agent 创建配置</p>
      )}
        </>
      ) : (
        /* 收缩态：一行状态条（agent · profile · model · cwd），右侧动作 */
        <div className="mb-1 flex h-7 items-center gap-2 text-xs text-l4">
          <span className="truncate">
            {agentLabel(agentId)}
            {selectedProfile ? ` · ${selectedProfile.name}` : ""}
            {model ? ` · ${model}` : ""}
            {` · ${basename(cwd)}`}
            {shellActive && !running ? " · shell 模式" : ""}
            {exited && !running && !shellActive ? " · 已退出" : ""}
          </span>
          {error && <span className="truncate text-err-text">{error}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            {running && (
              <button onClick={stop} className="text-err-text hover:underline">
                停止
              </button>
            )}
            <button
              onClick={onOpenSessionPanel}
              disabled={!running && !sessionFile}
              title="查看当前会话的结构化对话"
              className="text-l3 hover:text-l1 disabled:opacity-50"
            >
              会话
            </button>
            <button
              onClick={() => setBarExpanded(true)}
              title="重新展开启动栏"
              className="text-l3 hover:text-l1"
            >
              修改
            </button>
          </span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          className="min-w-0 flex-1 overflow-hidden px-3 py-2.5"
        />
      </div>
    </div>
  );
}

interface Tab {
  id: string;
  /** 兜底空标签：不继承「上次启动」记录（关闭最后标签时使用） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建时预填的启动目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（端口段） */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名） */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 首次可见自动启动（会话恢复） */
  autoStart?: boolean;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：自动开 shell 执行 prefillCommand */
  shellOnly?: boolean;
}

const INITIAL_TAB: Tab = { id: crypto.randomUUID() };

export default function TerminalPage({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>([INITIAL_TAB]);
  const [activeId, setActiveId] = useState(INITIAL_TAB.id);
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  // 各标签的会话联动数据（TerminalView 轮询后镜像上来）
  const [sessionByTab, setSessionByTab] = useState<Record<string, SessionLinkState>>({});
  // 左栏（工作树 + 运行中总览）
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /** 最近项目「真进入」：待注入活动标签启动栏的目录 */
  const [enterCwd, setEnterCwd] = useState<string | null>(null);
  // 运行中总览：默认折叠；首次有 agent 运行时自动展开一次
  const [railRunOpen, setRailRunOpen] = useState(false);
  const runAutoOpenedRef = useRef(false);
  // 右侧面板：默认收起，点「会话」或预览文件时打开
  const [rightOpen, setRightOpen] = useState(false);
  // 专注模式：隐藏左栏与右面板，终端全宽（页级开关，默认关）
  const [focusMode, setFocusMode] = useState(false);
  const [rightTab, setRightTab] = useState<"session" | "preview" | "git">("session");
  const [gitTotals, setGitTotals] = useState<{ add: number; del: number } | null>(null);
  const [preview, setPreview] = useState<{ path: string; name: string; root: string | null } | null>(null);
  /** 预览编辑器脏状态（预览页签的脏点） */
  const [previewDirty, setPreviewDirty] = useState(false);
  /** 文件系统变化信号：FileTree 的 fs-changed 事件触发 GitPanel 一并刷新 */
  const [fsChangeTick, setFsChangeTick] = useState(0);
  const sessionScrollRef = useRef<HTMLDivElement>(null);

  const activeCwd = statuses[activeId]?.cwd ?? "~";

  /** TerminalView 上报状态；内容没变就返回原对象，避免无谓重渲染 */
  const reportStatus = useCallback((id: string, s: TabStatus) => {
    setStatuses((prev) => {
      const cur = prev[id];
      if (cur && JSON.stringify(cur) === JSON.stringify(s)) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** TerminalView 镜像会话联动数据；引用没变就不更新 */
  const reportSession = useCallback((id: string, s: SessionLinkState) => {
    setSessionByTab((prev) => {
      const cur = prev[id];
      if (cur && cur.file === s.file && cur.conv === s.conv) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** GitPanel 上报改动总量（改动页签的 +N 徽标）；没变就不更新 */
  const reportGitTotals = useCallback((t: { add: number; del: number }) => {
    setGitTotals((prev) => (prev && prev.add === t.add && prev.del === t.del ? prev : t));
  }, []);

  /** 工作树单击文件 → 右侧「预览」页签（编辑器自行加载内容；路径限制在后端校验） */
  function openPreview(path: string, name: string, root?: string) {
    setRightOpen(true);
    setRightTab("preview");
    setPreview({ path, name, root: root ?? null });
    setPreviewDirty(false);
  }

  // 会话页签内容更新时滚到底部
  const activeSession = sessionByTab[activeId];
  useEffect(() => {
    const el = sessionScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeSession?.conv, rightTab, rightOpen, activeId]);

  function addTab(init?: {
    cwd?: string;
    extraEnv?: Record<string, string>;
    title?: string;
    agentId?: string;
    profileId?: string;
    model?: string;
    resumeSessionId?: string;
    autoStart?: boolean;
    prefillCommand?: string;
    shellOnly?: boolean;
  }): string {
    const t: Tab = {
      id: crypto.randomUUID(),
      initialCwd: init?.cwd,
      initialExtraEnv: init?.extraEnv,
      initialTitle: init?.title,
      initialAgentId: init?.agentId,
      initialProfileId: init?.profileId,
      initialModel: init?.model,
      resumeSessionId: init?.resumeSessionId,
      autoStart: init?.autoStart,
      prefillCommand: init?.prefillCommand,
      shellOnly: init?.shellOnly,
    };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    return t.id;
  }

  /** 工作树「在此打开新终端」：新建标签并预填 cwd，用户选 agent/profile 后启动 */
  function openTerminalAt(path: string) {
    addTab({ cwd: path });
  }

  // 消费工作区页/会话页交来的终端启动请求（可见时才消费，保证标签能立刻聚焦启动栏）
  const pendingTerminal = useAppStore((s) => s.pendingTerminal);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setRunningScript = useAppStore((s) => s.setRunningScript);
  // closeTab 里取最新互斥登记表（避免闭包过期）
  const runningScripts = useAppStore((s) => s.runningScripts);
  const runningScriptsRef = useRef(runningScripts);
  runningScriptsRef.current = runningScripts;
  const profiles = useAppStore((s) => s.profiles);
  useEffect(() => {
    if (visible && pendingTerminal) {
      setPendingTerminal(null);
      const pt = pendingTerminal;
      // 会话恢复：profile 依次 autoLaunchProfileId → ccode.lastProfile → 该 agent 首个配置
      const agentId = pt.agentId ?? pt.resume?.agentId;
      let profileId = pt.profileId;
      let model = pt.model;
      if (pt.resume) {
        profileId =
          pt.autoLaunchProfileId ??
          localStorage.getItem(`ccode.lastProfile.${pt.resume.agentId}`) ??
          profiles.find((p) => p.agent === pt.resume!.agentId)?.id ??
          "";
        model = profiles.find((p) => p.id === profileId)?.models[0] ?? "";
      }
      const tabId = addTab({
        cwd: pt.cwd,
        extraEnv: pt.extraEnv,
        title: pt.title,
        agentId,
        profileId,
        model,
        resumeSessionId: pt.resume?.sessionId,
        autoStart: !!pt.resume,
        prefillCommand: pt.prefillCommand,
        shellOnly: pt.shellOnly,
      });
      // run 脚本标签：登记 nonconcurrent 互斥追踪
      if (pt.wsId) setRunningScript(pt.wsId, tabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pendingTerminal, setPendingTerminal, setRunningScript]);

  // 会话页「进行中」反向跳转：聚焦指定标签
  const focusTabId = useAppStore((s) => s.focusTabId);
  const focusTab = useAppStore((s) => s.focusTab);
  useEffect(() => {
    if (visible && focusTabId) {
      if (tabs.some((t) => t.id === focusTabId)) setActiveId(focusTabId);
      focusTab(null);
    }
  }, [visible, focusTabId, tabs, focusTab]);

  // 运行中总览：首次有 agent 运行时自动展开一次，之后尊重用户手动开关
  useEffect(() => {
    if (!runAutoOpenedRef.current && Object.values(statuses).some((s) => s.running)) {
      runAutoOpenedRef.current = true;
      setRailRunOpen(true);
    }
  }, [statuses]);

  // 可见性门控（优化 2）：只有活动标签的 PTY 推流，其余（含整页隐藏时全部）进后台缓冲。
  // PTY 被替换（agent→shell 回落换新 id）时 statuses 变化会触发重新标记。
  useEffect(() => {
    for (const [tabId, s] of Object.entries(statuses)) {
      if (s.ptyId) {
        invoke("pty_set_visible", {
          ptyId: s.ptyId,
          visible: visible && tabId === activeId,
        }).catch(() => {});
      }
    }
  }, [activeId, statuses, visible]);

  function closeTab(id: string) {
    const s = statuses[id];
    if (
      s?.running &&
      !window.confirm("该标签页的 agent 正在运行，关闭将终止进程。继续？")
    )
      return;
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    if (next.length === 0) {
      // 至少保留一个标签
      const fresh: Tab = { id: crypto.randomUUID(), skipSeed: true };
      setTabs([fresh]);
      setActiveId(fresh.id);
    } else {
      setTabs(next);
      if (id === activeId) setActiveId(next[Math.max(0, idx - 1)].id);
    }
    // 被关标签的 TerminalView 卸载时会自行杀掉 PTY（其 unmount 清理路径）
    setStatuses((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setSessionByTab((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    // run 脚本互斥登记随标签关闭释放
    for (const [wsId, tabId] of Object.entries(runningScriptsRef.current)) {
      if (tabId === id) setRunningScript(wsId, null);
    }
  }

  const railBtn =
    "flex h-7 w-7 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l2";

  return (
    <div className="flex h-full">
      {/* 左栏：工作树 + 运行中总览（专注模式下整体隐藏） */}
      {!focusMode &&
        (railCollapsed ? (
        <div className="flex w-8 shrink-0 flex-col items-center bg-rail2 py-1.5">
          <button
            onClick={() => setRailCollapsed(false)}
            title="展开工作树"
            className={railBtn}
          >
            »
          </button>
        </div>
      ) : (
        <div className="flex w-60 shrink-0 flex-col bg-rail2">
          <div className="flex shrink-0 items-center gap-2 px-2 py-1.5">
            <span className="mr-auto text-xs font-medium text-l3">工作树</span>
            <button
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
              className={`flex h-7 w-7 items-center justify-center rounded text-xs hover:bg-white/5 ${
                showHidden ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              .*
            </button>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              title="刷新"
              className={railBtn}
            >
              ⟳
            </button>
            <button
              onClick={() => setRailCollapsed(true)}
              title="收起工作树"
              className={railBtn}
            >
              «
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <FileTree
              cwd={activeCwd}
              showHidden={showHidden}
              refreshKey={refreshKey}
              onOpenFile={openPreview}
              onOpenTerminal={openTerminalAt}
              onFsEvent={() => setFsChangeTick((t) => t + 1)}
              onEnterProject={setEnterCwd}
            />
          </div>
          {/* 运行中总览：全部终端标签的状态一览，点击激活；默认折叠 */}
          <div className="shrink-0 bg-strip">
            <button
              onClick={() => setRailRunOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-xs text-l4 hover:text-l2"
            >
              <span>{railRunOpen ? "▾" : "▸"}</span>
              <span>运行中 ({tabs.length})</span>
            </button>
            {railRunOpen && (
              <div className="max-h-56 overflow-auto">
                {tabs.map((t) => {
              const s = statuses[t.id];
              const active = t.id === activeId;
              const dot = s?.running
                ? `text-ok-text${s.attention === "working" ? " animate-pulse" : ""}`
                : s?.shell
                  ? "text-l3"
                  : "text-l4";
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  className={`mx-1 flex w-[calc(100%-8px)] items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5 ${
                    active ? "bg-rail-sel" : ""
                  }`}
                >
                  <span className={`shrink-0 text-[10px] ${dot}`}>●</span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate font-medium ${active ? "text-l1" : "text-l2"}`}
                    >
                      {s?.title ?? "终端"}
                    </span>
                    <span
                      className={`block truncate ${active ? "text-l2" : "text-l4"}`}
                    >
                      {s
                        ? `${agentLabel(s.agentId)}${s.model ? ` · ${s.model}` : ""} · ${basename(s.cwd)}`
                        : ""}
                      {s?.attention === "done" && (
                        <span className="text-link"> · 已完成</span>
                      )}
                      {s?.attention === "confirm" && (
                        <span className="text-warn-text"> · 待确认</span>
                      )}
                    </span>
                  </span>
                </button>
                );
              })}
              </div>
            )}
          </div>
        </div>
      ))}

      {/* 中带：终端标签区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 items-center gap-1 overflow-x-auto bg-strip px-2">
          {tabs.map((t) => {
            const s = statuses[t.id];
            const active = t.id === activeId;
            return (
              <div
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`group/tab flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-xs ${
                  active
                    ? "border-cta text-l1"
                    : "border-transparent text-l3 hover:text-l1"
                }`}
              >
                <span
                  className={`text-[10px] ${
                    s?.running
                      ? `text-ok-text${s.attention === "working" ? " animate-pulse" : ""}`
                      : s?.shell
                        ? "text-l3"
                        : "text-l4"
                  }`}
                  title={
                    s?.running
                      ? s.attention === "working"
                        ? "工作中"
                        : "agent 运行中"
                      : s?.shell
                        ? "shell 模式"
                        : "未运行 / 已退出"
                  }
                >
                  ●
                </span>
                {s?.attention === "done" && (
                  <span className="text-[10px] text-link" title="已完成，等待输入">
                    ●
                  </span>
                )}
                {s?.attention === "confirm" && (
                  <span className="text-[10px] text-warn-text" title="等待确认">
                    ●
                  </span>
                )}
                <span className="max-w-40 truncate">{s?.title ?? "终端"}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  aria-label="关闭标签"
                  className={`text-l4 hover:text-err-text ${active ? "" : "invisible group-hover/tab:visible"}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={() => addTab()}
            title="新建终端标签"
            className="shrink-0 rounded px-1.5 text-sm text-l4 hover:text-l1"
          >
            ＋
          </button>
          <button
            onClick={() => setFocusMode((v) => !v)}
            title={focusMode ? "退出专注模式（恢复侧栏与面板）" : "专注模式（隐藏侧栏与面板）"}
            className={`ml-auto shrink-0 rounded px-2 py-0.5 text-xs ${
              focusMode ? "text-l1" : "text-l4 hover:text-l2"
            }`}
          >
            ⤢ 专注
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {/* 所有标签保持挂载，仅隐藏非活动标签，运行中的会话与 scrollback 得以保留 */}
          {tabs.map((t) => {
            const tabVisible = visible && t.id === activeId;
            return (
              <div key={t.id} className={tabVisible ? "h-full" : "hidden"}>
                <TerminalView
                  visible={tabVisible}
                  rightOpen={rightOpen}
                  tabId={t.id}
                  skipSeed={t.skipSeed}
                  initialCwd={t.initialCwd}
                  initialExtraEnv={t.initialExtraEnv}
                  initialTitle={t.initialTitle}
                  initialAgentId={t.initialAgentId}
                  initialProfileId={t.initialProfileId}
                  initialModel={t.initialModel}
                  resumeSessionId={t.resumeSessionId}
                  autoStart={t.autoStart}
                  prefillCommand={t.prefillCommand}
                  shellOnly={t.shellOnly}
                  externalCwd={t.id === activeId ? enterCwd : null}
                  onConsumeExternalCwd={() => setEnterCwd(null)}
                  onStatus={(s) => reportStatus(t.id, s)}
                  onSessionUpdate={(s) => reportSession(t.id, s)}
                  onOpenSessionPanel={() => {
                    setRightTab("session");
                    setRightOpen(true);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧面板：会话联动 / 文件预览 页签切换（专注模式下隐藏） */}
      {rightOpen && !focusMode && (
        <div className="flex w-[380px] shrink-0 flex-col border-l border-hairline bg-canvas">
          <div className="flex shrink-0 items-center gap-1 bg-strip px-2 py-1.5">
            {(["session", "preview", "git"] as const).map((k) => {
              const gitBadge =
                k === "git" && gitTotals && gitTotals.add + gitTotals.del > 0
                  ? gitTotals.add + gitTotals.del
                  : null;
              return (
                <button
                  key={k}
                  onClick={() => setRightTab(k)}
                  className={`rounded px-2.5 py-1 text-xs ${
                    rightTab === k
                      ? "bg-seg-sel text-l1"
                      : "text-l3 hover:text-l1"
                  }`}
                >
                  {k === "session" ? "会话" : k === "preview" ? "预览" : "改动"}
                  {k === "preview" && previewDirty && (
                    <span className="ml-1 text-l3" title="有未保存的修改">
                      ●
                    </span>
                  )}
                  {gitBadge && (
                    <span className="ml-1 rounded bg-ok px-1 text-ok-text">
                      +{gitBadge}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              onClick={() => setRightOpen(false)}
              title="收起面板"
              className="ml-auto text-xs text-l4 hover:text-l1"
            >
              ×
            </button>
          </div>
          {rightTab === "session" && (
            <div ref={sessionScrollRef} className="min-h-0 flex-1 overflow-auto p-3">
              {!activeSession?.file ? (
                <p className="text-sm text-l4">等待会话文件产生…</p>
              ) : activeSession.conv.length === 0 ? (
                <p className="text-sm text-l4">暂无对话内容</p>
              ) : (
                <ConversationView messages={activeSession.conv} compact />
              )}
            </div>
          )}
          {rightTab === "preview" && (
            <div className="flex min-h-0 flex-1 flex-col">
              {preview ? (
                <FilePreviewEditor
                  path={preview.path}
                  root={preview.root ?? activeCwd}
                  onDirtyChange={setPreviewDirty}
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex shrink-0 items-center bg-strip px-3 py-1.5 text-xs text-l3">
                    未选择文件
                  </div>
                  <div className="p-3">
                    <p className="text-sm text-l4">在左侧工作树中单击文件预览</p>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* 改动面板保持挂载：右栏打开期间持续轮询，页签徽标才有数据 */}
          <div className={rightTab === "git" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
            <GitPanel
              cwd={activeCwd}
              visible={visible && rightOpen}
              refreshKey={fsChangeTick}
              onTotals={reportGitTotals}
            />
          </div>
        </div>
      )}
    </div>
  );
}
