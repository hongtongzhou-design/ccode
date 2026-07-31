import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import type { ChatMessageDto, SessionMetaDto } from "../types";

type PtyKind = "agent" | "shell";

/** 标签页状态：由 TerminalView 上报，标签条用来渲染标题和运行指示 */
interface TabStatus {
  title: string;
  /** 有存活 PTY（agent 或 shell） */
  alive: boolean;
  /** agent 正在运行（关闭前需要确认） */
  running: boolean;
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/** 单个终端：独立持有 xterm 实例、PTY 引用和启动栏状态；隐藏时只 display:none，不杀进程 */
function TerminalView({
  visible,
  onStatus,
}: {
  visible: boolean;
  onStatus: (s: TabStatus) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  // 记住上次启动选择（agent/profile/模型/目录），每个新标签以此为初始值
  const saved = (() => {
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
  const [agentId, setAgentId] = useState<string>(saved.agentId ?? "claude-code");
  const [profileId, setProfileId] = useState(saved.profileId ?? "");
  const [model, setModel] = useState(saved.model ?? "");
  const [cwd, setCwd] = useState(saved.cwd ?? "~");
  const [running, setRunning] = useState(false); // agent 正在运行
  const [shellActive, setShellActive] = useState(false); // 当前接的是 shell
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyKindRef = useRef<PtyKind | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);

  // —— 会话联动（SessionLink）：当前 agent 会话的结构化对话侧栏 ——
  const [panelOpen, setPanelOpen] = useState(false);
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const linkCtxRef = useRef<{
    agentId: string;
    cwd: string;
    hint: string | null;
    sinceIso: string;
    filePath: string | null;
  } | null>(null);
  const linkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const selectedProfile = profiles.find((p) => p.id === profileId);

  // 向标签条上报标题/运行状态；值没变就不惊动父组件
  const title = selectedProfile?.name ?? agentLabel(agentId);
  const lastReportRef = useRef("");
  useEffect(() => {
    const s: TabStatus = { title, alive: running || shellActive, running };
    const key = JSON.stringify(s);
    if (key !== lastReportRef.current) {
      lastReportRef.current = key;
      onStatus(s);
    }
  }, [title, running, shellActive, onStatus]);

  // 懒挂载：首次可见时才创建 xterm，未展示过的标签不占用终端资源
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);

  useEffect(() => {
    if (!everVisible) return;
    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      // VS Code Dark+ 风格调色板，让 ANSI 高亮有足够的色彩层次
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#ffffff',
      },
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

  // 标签从隐藏切回可见时重新 fit（display:none 下尺寸为 0）
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {}
      });
    }
  }, [visible]);

  // 侧栏开关改变 xterm 可用宽度，需要重新 fit
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
  }, [panelOpen]);

  // 对话更新时滚到底部
  useEffect(() => {
    const el = panelScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv, panelOpen]);

  /** 把一个 PTY 接到 xterm 上；agent 退出时自动回落到 shell */
  async function attach(ptyId: string, kind: PtyKind, opts?: { reset?: boolean }) {
    const term = termRef.current!;
    if (opts?.reset) term.reset();
    unlistenRef.current.forEach((u) => u());
    ptyIdRef.current = ptyId;
    ptyKindRef.current = kind;
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
    setRunning(false);
    if (kind === "agent") {
      // agent 退出（含手动停止）→ 同一终端自动回落到登录 shell
      termRef.current?.write("\r\n\x1b[90m── agent 已退出，进入 shell ──\x1b[0m\r\n");
      try {
        const id = await invoke<string>("shell_spawn", { cwd });
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
  async function findSessionFile(): Promise<string | null> {
    const ctx = linkCtxRef.current;
    if (!ctx) return null;
    try {
      if (ctx.hint) {
        const list = await invoke<SessionMetaDto[]>("list_sessions");
        return (
          list.find((s) => s.agent === ctx.agentId && s.sessionId === ctx.hint)
            ?.filePath ?? null
        );
      }
      const meta = await invoke<SessionMetaDto | null>("find_session_for", {
        agent: ctx.agentId,
        cwd: ctx.cwd,
        sinceIso: ctx.sinceIso,
      });
      return meta?.filePath ?? null;
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
  }

  async function linkTick() {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const fp = await findSessionFile();
      if (!fp) return;
      ctx.filePath = fp;
      setSessionFile(fp);
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
      ctx.filePath = await findSessionFile();
      if (ctx.filePath) setSessionFile(ctx.filePath);
    }
    await fetchConversation();
  }

  function resetLink() {
    stopLinkTimer();
    linkCtxRef.current = null;
    setSessionFile(null);
    setConv([]);
  }

  async function launch() {
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
        },
      );
      localStorage.setItem(
        "ccode.lastLaunch",
        JSON.stringify({ agentId, profileId, model, cwd }),
      );
      // SessionLink：记录启动上下文，开始轮询会话文件
      linkCtxRef.current = {
        agentId,
        cwd,
        hint: res.sessionHint,
        sinceIso: new Date().toISOString(),
        filePath: null,
      };
      startLinkPolling();
      await attach(res.ptyId, "agent", { reset: true });
      setExited(false);
      setShellActive(false);
      setRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openShell() {
    setError(null);
    await cleanupPty();
    try {
      const ptyId = await invoke<string>("shell_spawn", { cwd });
      await attach(ptyId, "shell", { reset: true });
      setExited(false);
      setShellActive(true);
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
    "rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500";

  return (
    <div className="flex h-full flex-col p-4">
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
        <select
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
            className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            停止
          </button>
        ) : (
          <>
            <button
              onClick={launch}
              disabled={!profileId}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              启动
            </button>
            <button
              onClick={openShell}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
            >
              打开 Shell
            </button>
          </>
        )}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          disabled={!running && !sessionFile}
          title="查看当前会话的结构化对话"
          className={`rounded px-3 py-1.5 text-sm disabled:opacity-50 ${
            panelOpen
              ? "bg-neutral-800 text-white"
              : "border border-neutral-300 hover:bg-neutral-100"
          }`}
        >
          会话
        </button>
        {shellActive && !running && (
          <span className="text-sm text-neutral-500">shell 模式</span>
        )}
        {exited && !running && !shellActive && (
          <span className="text-sm text-neutral-500">进程已退出</span>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
      {agentProfiles.length === 0 && (
        <p className="mb-2 text-sm text-neutral-500">
          该 agent 暂无配置，请先在「配置」页创建。
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={containerRef}
          className="min-w-0 flex-1 overflow-hidden rounded bg-black p-1"
        />
        {panelOpen && (
          <div className="flex w-[45%] shrink-0 flex-col overflow-hidden rounded border border-neutral-200 bg-white">
            <div className="shrink-0 border-b border-neutral-200 px-3 py-2 text-xs text-neutral-500">
              当前会话 · {agentLabel(agentId)}
              {model ? ` · ${model}` : ""}
            </div>
            <div ref={panelScrollRef} className="min-h-0 flex-1 overflow-auto p-3">
              {!sessionFile ? (
                <p className="text-sm text-neutral-400">等待会话文件产生…</p>
              ) : conv.length === 0 ? (
                <p className="text-sm text-neutral-400">暂无对话内容</p>
              ) : (
                <ConversationView messages={conv} compact />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface Tab {
  id: string;
}

const INITIAL_TAB: Tab = { id: crypto.randomUUID() };

export default function TerminalPage({ visible }: { visible: boolean }) {
  const [tabs, setTabs] = useState<Tab[]>([INITIAL_TAB]);
  const [activeId, setActiveId] = useState(INITIAL_TAB.id);
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});

  /** TerminalView 上报状态；内容没变就返回原对象，避免无谓重渲染 */
  const reportStatus = useCallback((id: string, s: TabStatus) => {
    setStatuses((prev) => {
      const cur = prev[id];
      if (cur && cur.title === s.title && cur.alive === s.alive && cur.running === s.running) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  function addTab() {
    const t: Tab = { id: crypto.randomUUID() };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  }

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
      const fresh: Tab = { id: crypto.randomUUID() };
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
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50 px-2 pt-1.5">
        {tabs.map((t) => {
          const s = statuses[t.id];
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t px-3 py-1.5 text-sm ${
                active
                  ? "-mb-px border border-b-0 border-neutral-200 bg-white"
                  : "text-neutral-500 hover:bg-neutral-100"
              }`}
            >
              <span
                className={`text-[10px] ${s?.alive ? "text-green-600" : "text-neutral-300"}`}
                title={s?.alive ? "进程运行中" : "未运行 / 已退出"}
              >
                ●
              </span>
              <span className="max-w-40 truncate">{s?.title ?? "终端"}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                aria-label="关闭标签"
                className="text-neutral-400 hover:text-red-600"
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          onClick={addTab}
          title="新建终端标签"
          className="ml-1 shrink-0 rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
        >
          ＋
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
                onStatus={(s) => reportStatus(t.id, s)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
