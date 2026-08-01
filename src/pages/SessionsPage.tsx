import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import GitPanel from "../components/GitPanel";
import type { ChatMessageDto, SessionMetaDto, TokenUsageDto } from "../types";

/** GitPanel 的 onTotals 占位（会话页不消费改动总量；稳定引用避免击穿 memo） */
const NOOP_TOTALS = () => {};

type Filter =
  | { kind: "all" }
  | { kind: "agent"; agent: string }
  // 项目挂在 agent 下，筛选必须同时限定 agent 和路径（同名目录可能跨 agent）
  | { kind: "project"; agent: string; path: string };

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

function fmtTokens(u: TokenUsageDto | null): string {
  if (!u) return "";
  const k = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
  return `↑${k(u.input)} ↓${k(u.output)}`;
}

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function sessionTitle(s: SessionMetaDto): string {
  return s.customTitle || s.title || s.sessionId.slice(0, 8);
}

export default function SessionsPage({ visible }: { visible: boolean }) {
  const sessions = useAppStore((s) => s.sessions);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const openSessionReq = useAppStore((s) => s.openSessionReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const liveSessions = useAppStore((s) => s.liveSessions);
  const focusTab = useAppStore((s) => s.focusTab);
  const sessionsQuery = useAppStore((s) => s.sessionsQuery);
  const setSessionsQuery = useAppStore((s) => s.setSessionsQuery);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [showArchived, setShowArchived] = useState(false);
  // 分类树里收起的 agent（默认全部展开）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // 批量删除：选择模式 + 勾选集合（键为 agent+sessionId 复合键，防跨 agent 撞 id）
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [selected, setSelected] = useState<SessionMetaDto | null>(null);
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [loadingConv, setLoadingConv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 行内编辑中的会话（编辑期间暂停轮询，避免覆盖输入）
  const [editing, setEditing] = useState<{
    agent: string;
    sessionId: string;
    title: string;
    tags: string;
  } | null>(null);
  // 右键菜单：会话行或树里的项目节点
  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: "session"; session: SessionMetaDto }
    | { x: number; y: number; kind: "project"; agent: string; path: string; count: number }
    | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  editingRef.current = editing !== null;
  const selectedRef = useRef<SessionMetaDto | null>(null);
  selectedRef.current = selected;

  const q = query.trim().toLowerCase();
  // 工作区页「会话」跳转：接管搜索词（消费并清空）
  useEffect(() => {
    if (sessionsQuery != null) {
      setQuery(sessionsQuery);
      setSessionsQuery(null);
    }
  }, [sessionsQuery, setSessionsQuery]);
  const searched = useMemo(() => {
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.projectPath, s.title ?? "", s.customTitle ?? "", s.workspace ?? "", ...s.tags]
        .join("\n")
        .toLowerCase()
        .includes(q),
    );
  }, [sessions, q]);

  /** A. 会话恢复：把会话交给终端页以 resume 语义自动重启 */
  function resumeInTerminal(s: SessionMetaDto) {
    setPendingTerminal({
      cwd: s.projectPath,
      extraEnv: {},
      title: s.customTitle || s.title || s.sessionId.slice(0, 8),
      resume: { agentId: s.agent, sessionId: s.sessionId },
    });
    setPage("terminal");
  }

  /** B. 「进行中」反向跳转：聚焦该会话所在的终端标签 */
  function jumpToLive(sessionId: string) {
    const tabId = liveSessions[sessionId];
    if (!tabId) return;
    setPage("terminal");
    focusTab(tabId);
  }

  // 分类树：agent → 项目分组；sessions 已按 updatedAt 降序，组内第一条即最近会话
  const tree = useMemo(() => {
    const byAgent = new Map<string, SessionMetaDto[]>();
    for (const s of searched) {
      const g = byAgent.get(s.agent);
      if (g) g.push(s);
      else byAgent.set(s.agent, [s]);
    }
    return [...byAgent.entries()]
      .map(([agent, list]) => {
        const byProject = new Map<string, SessionMetaDto[]>();
        for (const s of list) {
          const g = byProject.get(s.projectPath);
          if (g) g.push(s);
          else byProject.set(s.projectPath, [s]);
        }
        const projects = [...byProject.entries()]
          .map(([path, pl]) => ({ path, list: pl }))
          .sort((a, b) =>
            (b.list[0]?.updatedAt ?? "").localeCompare(a.list[0]?.updatedAt ?? ""),
          );
        return { agent, list, projects };
      })
      .sort(
        (a, b) =>
          AGENTS.findIndex((x) => x.id === a.agent) -
          AGENTS.findIndex((x) => x.id === b.agent),
      );
  }, [searched]);

  const sessionList = useMemo(() => {
    let src = searched;
    if (filter.kind === "agent") src = src.filter((s) => s.agent === filter.agent);
    else if (filter.kind === "project")
      src = src.filter(
        (s) => s.agent === filter.agent && s.projectPath === filter.path,
      );
    return src.filter((s) => showArchived || !s.archived);
  }, [searched, filter, showArchived]);

  /** 切换树筛选：同时退出回放态回到列表，保证右栏与所选节点对应 */
  function selectFilter(f: Filter) {
    setFilter(f);
    setSelected(null);
  }

  /** 当前筛选的可读描述，显示在列表头部，便于确认右栏与所选节点一致 */
  const filterLabel =
    filter.kind === "agent"
      ? agentLabel(filter.agent)
      : filter.kind === "project"
        ? `${agentLabel(filter.agent)} · ${basename(filter.path)}`
        : "全部会话";

  const [summary, setSummary] = useState<string | null>(null);
  const [aiSummarizing, setAiSummarizing] = useState(false);
  // 导出 Markdown 结果路径（小字提示，随切换会话清空）
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  /** 回放区页签：对话 / 改动（改动 = 该会话项目的 git diff 面板） */
  const [replayTab, setReplayTab] = useState<"chat" | "diff">("chat");

  /** ◈ AI 摘要：生成/重新生成当前回放会话的摘要块 */
  async function onSummarize() {
    if (!selected) return;
    setAiSummarizing(true);
    try {
      const text = await invoke<string>("ai_summarize_session", {
        agent: selected.agent,
        sessionId: selected.sessionId,
        filePath: selected.filePath,
      });
      setSummary(text);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setAiSummarizing(false);
    }
  }

  /** 导出当前回放会话为 Markdown（落 ~/Downloads/ccode-exports/，路径由后端返回） */
  async function onExport() {
    if (!selected) return;
    setExporting(true);
    setExportPath(null);
    try {
      const path = await invoke<string>("export_session_markdown", {
        agent: selected.agent,
        sessionId: selected.sessionId,
        filePath: selected.filePath,
        title: sessionTitle(selected),
      });
      setExportPath(path);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  // 终端页「⤴对话」跳转：按 sessionId 直接打开回放（列表加载完成后消费一次）
  useEffect(() => {
    if (!openSessionReq || sessions.length === 0) return;
    const hit = sessions.find((x) => x.sessionId === openSessionReq.sessionId);
    setOpenSessionReq(null);
    if (hit) {
      setFilter({ kind: "all" });
      void openSession(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSessionReq, sessions]);

  async function openSession(s: SessionMetaDto) {
    // 源文件已删除且无快照，无法回放
    if (!s.alive && !s.pinned) return;
    setSelected(s);
    setReplayTab("chat");
    // 摘要缓存命中：已有 summary 直接展示，不再调用 AI
    setSummary(s.summary ?? null);
    setExportPath(null);
    setLoadingConv(true);
    setError(null);
    try {
      const conv = await invoke<ChatMessageDto[]>("get_session_conversation", {
        agent: s.agent,
        filePath: s.filePath,
      });
      setMessages(conv);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingConv(false);
    }
  }

  // 页面可见时每 8s 轮询（后端扫描结果缓存 10s，更密的轮询无意义）；
  // 当前打开的会话 updatedAt 变了就重拉对话
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped || editingRef.current) return;
      try {
        const fresh = await loadSessions();
        const cur = selectedRef.current;
        if (!cur) return;
        const updated = fresh.find(
          (s) => s.agent === cur.agent && s.sessionId === cur.sessionId,
        );
        if (updated && updated.updatedAt !== cur.updatedAt) {
          setSelected(updated);
          const conv = await invoke<ChatMessageDto[]>("get_session_conversation", {
            agent: updated.agent,
            filePath: updated.filePath,
          });
          if (!stopped) setMessages(conv);
        }
      } catch {
        // 轮询失败静默，下轮再试
      }
    }, 8000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, loadSessions]);

  // 右键菜单打开时：Escape / 任意滚动关闭；点击空白由遮罩处理
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onScroll = () => setMenu(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu]);

  // 批量删除二次确认 4s 后自动复原
  useEffect(() => {
    if (!confirmBatch) return;
    const t = setTimeout(() => setConfirmBatch(false), 4000);
    return () => clearTimeout(t);
  }, [confirmBatch]);

  async function togglePin(s: SessionMetaDto) {
    setError(null);
    try {
      if (s.pinned) {
        if (!window.confirm("取消保留并删除本地快照？")) return;
        await invoke("unpin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          deleteSnapshot: true,
        });
      } else {
        await invoke("pin_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          filePath: s.filePath,
        });
      }
      const fresh = await loadSessions();
      // 头部按钮状态随最新数据刷新
      const cur = selectedRef.current;
      if (cur) {
        setSelected(
          fresh.find((x) => x.agent === cur.agent && x.sessionId === cur.sessionId) ??
            cur,
        );
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleArchive(s: SessionMetaDto) {
    setError(null);
    try {
      await invoke("set_session_meta", {
        agent: s.agent,
        sessionId: s.sessionId,
        customTitle: s.customTitle,
        tags: s.tags,
        archived: !s.archived,
      });
      await loadSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  /** 删除单个会话（源文件+快照+整理数据，后端一并处理）；正在回放的被删则退出回放 */
  async function deleteSession(s: SessionMetaDto) {
    setError(null);
    if (
      !window.confirm("删除该会话的本地文件？保留的快照和整理数据会一并删除，不可恢复。")
    )
      return;
    try {
      await invoke("delete_session", {
        agent: s.agent,
        sessionId: s.sessionId,
        filePath: s.filePath,
      });
      const cur = selectedRef.current;
      if (cur && cur.agent === s.agent && cur.sessionId === s.sessionId) {
        setSelected(null);
        setMessages([]);
      }
      await loadSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  /** 删除某 agent 下某项目的全部会话 */
  async function deleteProjectSessions(agent: string, path: string, count: number) {
    setError(null);
    if (
      !window.confirm(
        `将删除 ${agentLabel(agent)} 下 ${basename(path)} 的 ${count} 个会话文件，不可恢复。继续？`,
      )
    )
      return;
    try {
      await invoke("delete_project_sessions", { agent, projectPath: path });
      const cur = selectedRef.current;
      if (cur && cur.agent === agent && cur.projectPath === path) {
        setSelected(null);
        setMessages([]);
      }
      await loadSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  const skey = (s: SessionMetaDto) => `${s.agent}\n${s.sessionId}`;

  function toggleChecked(s: SessionMetaDto) {
    setConfirmBatch(false);
    setChecked((prev) => {
      const next = new Set(prev);
      const k = skey(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /** 全选/取消全选当前筛选结果（sessionList 已含搜索、树筛选、归档开关） */
  const allChecked =
    sessionList.length > 0 && sessionList.every((s) => checked.has(skey(s)));
  // 只统计/删除当前筛选结果内的勾选项，防止误删不可见行
  const checkedInView = sessionList.reduce(
    (n, s) => n + (checked.has(skey(s)) ? 1 : 0),
    0,
  );
  function toggleSelectAll() {
    setConfirmBatch(false);
    setChecked(allChecked ? new Set() : new Set(sessionList.map(skey)));
  }

  function exitSelectMode() {
    setSelecting(false);
    setChecked(new Set());
    setConfirmBatch(false);
  }

  /** 批量删除：逐个走 delete_session，语义与单个删除一致（pin 快照/整理数据由后端一并清理） */
  async function batchDelete() {
    const targets = sessionList.filter((s) => checked.has(skey(s)));
    if (targets.length === 0) return;
    setBatchDeleting(true);
    setError(null);
    const failed: string[] = [];
    for (const s of targets) {
      try {
        await invoke("delete_session", {
          agent: s.agent,
          sessionId: s.sessionId,
          filePath: s.filePath,
        });
      } catch {
        failed.push(sessionTitle(s));
      }
    }
    // 正在回放的会话被删则退出回放
    const cur = selectedRef.current;
    if (cur && checked.has(skey(cur))) {
      setSelected(null);
      setMessages([]);
    }
    setBatchDeleting(false);
    exitSelectMode();
    await loadSessions();
    if (failed.length > 0)
      setError(
        `已删除 ${targets.length - failed.length} 项，${failed.length} 项失败：${failed.join("、")}`,
      );
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    const cur = sessions.find(
      (s) => s.agent === editing.agent && s.sessionId === editing.sessionId,
    );
    try {
      await invoke("set_session_meta", {
        agent: editing.agent,
        sessionId: editing.sessionId,
        customTitle: editing.title.trim() || null,
        tags: editing.tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        archived: cur?.archived ?? false,
      });
      setEditing(null);
      await loadSessions();
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleCollapsed(agent: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agent)) next.delete(agent);
      else next.add(agent);
      return next;
    });
  }

  const input =
    "w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";
  const menuItem = "block w-full px-3 py-1.5 text-left text-l2 hover:bg-white/5";

  const filterActive = (f: Filter) =>
    (filter.kind === "all" && f.kind === "all") ||
    (filter.kind === "agent" && f.kind === "agent" && filter.agent === f.agent) ||
    (filter.kind === "project" &&
      f.kind === "project" &&
      filter.agent === f.agent &&
      filter.path === f.path);

  return (
    <div className="flex h-full">
      {/* 左栏：分类树 */}
      <div className="flex w-[230px] shrink-0 flex-col bg-rail2">
        <div className="p-2">
          <input
            className="w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
            placeholder="搜索项目 / 会话 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <button
            onClick={() => selectFilter({ kind: "all" })}
            className={`mx-1 block w-[calc(100%-8px)] rounded-md px-3 py-2 text-left text-sm ${
              filterActive({ kind: "all" })
                ? "bg-rail-sel text-l1"
                : "text-l3 hover:bg-white/5"
            }`}
          >
            全部会话
            <span className={`ml-1 text-xs ${filterActive({ kind: "all" }) ? "text-l2" : "text-l4"}`}>{searched.length}</span>
          </button>
          {tree.map((g) => (
            <div key={g.agent}>
              <div
                onClick={() => selectFilter({ kind: "agent", agent: g.agent })}
                className={`mx-1 flex w-[calc(100%-8px)] cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm ${
                  filterActive({ kind: "agent", agent: g.agent })
                    ? "bg-rail-sel text-l1"
                    : "text-l3 hover:bg-white/5"
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapsed(g.agent);
                    selectFilter({ kind: "agent", agent: g.agent });
                  }}
                  className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-l4 hover:bg-white/5 hover:text-l2"
                  title={collapsed.has(g.agent) ? "展开" : "收起"}
                >
                  {collapsed.has(g.agent) ? "▸" : "▾"}
                </button>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate font-medium">{agentLabel(g.agent)}</span>
                  <span
                    className={`shrink-0 text-xs ${
                      filterActive({ kind: "agent", agent: g.agent })
                        ? "text-l2"
                        : "text-l4"
                    }`}
                  >
                    {g.list.length}
                  </span>
                </span>
              </div>
              {!collapsed.has(g.agent) &&
                g.projects.map((p) => {
                  const active = filterActive({
                    kind: "project",
                    agent: g.agent,
                    path: p.path,
                  });
                  return (
                    <button
                      key={p.path}
                      onClick={() =>
                        selectFilter({ kind: "project", agent: g.agent, path: p.path })
                      }
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          kind: "project",
                          agent: g.agent,
                          path: p.path,
                          count: p.list.length,
                        });
                      }}
                      title={p.path}
                      className={`mx-1 flex w-[calc(100%-8px)] items-center justify-between gap-2 rounded-md py-1.5 pl-8 pr-3 text-left text-sm ${
                        active
                          ? "bg-rail-sel text-l1"
                          : "text-l3 hover:bg-white/5"
                      }`}
                    >
                      <span className="truncate">{basename(p.path)}</span>
                      <span
                        className={`shrink-0 text-xs ${active ? "text-l2" : "text-l4"}`}
                      >
                        {p.list.length}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
          {tree.length === 0 && (
            <p className="p-3 text-sm text-l4">暂无会话</p>
          )}
        </div>
      </div>

      {/* 右栏：列表 / 回放 二选一（列表保持挂载以保留滚动与筛选） */}
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* 会话列表 */}
        <div className={`flex min-h-0 flex-1 flex-col ${selected ? "hidden" : ""}`}>
          {error && <p className="px-4 py-1 text-xs text-err-text">{error}</p>}
          <div className="flex items-baseline justify-between bg-strip px-4 py-2">
            {selecting ? (
              <>
                <span className="text-xs text-l3">已选 {checkedInView} 项</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={toggleSelectAll}
                    className="rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5 hover:text-l1"
                  >
                    {allChecked ? "取消全选" : "全选（当前筛选结果）"}
                  </button>
                  <button
                    disabled={checkedInView === 0 || batchDeleting}
                    onClick={() => {
                      if (confirmBatch) {
                        setConfirmBatch(false);
                        void batchDelete();
                      } else {
                        setConfirmBatch(true);
                      }
                    }}
                    className="rounded px-2 py-0.5 text-xs text-err-text hover:bg-white/5 disabled:opacity-50"
                  >
                    {batchDeleting
                      ? "删除中…"
                      : confirmBatch
                        ? `确认删除 ${checkedInView} 项？`
                        : `删除 ${checkedInView} 项`}
                  </button>
                  <button
                    onClick={exitSelectMode}
                    className="rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5 hover:text-l1"
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-xs text-l3">
                  {filterLabel} · {sessionList.length} 个会话
                </span>
                <div className="flex items-center gap-1">
                  <label className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={(e) => setShowArchived(e.target.checked)}
                    />
                    显示已归档
                  </label>
                  <button
                    onClick={() => setSelecting(true)}
                    className="rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5 hover:text-l1"
                  >
                    选择
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {sessionList.map((s) => {
              const isEditing =
                editing?.agent === s.agent && editing.sessionId === s.sessionId;
              if (isEditing && editing) {
                return (
                  <div
                    key={s.sessionId}
                    className="space-y-2 border-b border-hairline bg-inset p-4"
                  >
                    <input
                      className={input}
                      placeholder="自定义标题（留空则用原标题）"
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      autoFocus
                    />
                    <input
                      className={input}
                      placeholder="标签，逗号分隔"
                      value={editing.tags}
                      onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
                    />
                    <div className="flex justify-end gap-2 text-sm">
                      <button
                        onClick={() => setEditing(null)}
                        className="text-l3 hover:text-l1"
                      >
                        取消
                      </button>
                      <button onClick={saveEdit} className="text-l1 hover:underline">
                        保存
                      </button>
                    </div>
                  </div>
                );
              }
              const clickable = s.alive || s.pinned;
              return (
                <div
                  key={s.sessionId}
                  onClick={() => (selecting ? toggleChecked(s) : openSession(s))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (selecting) return;
                    setMenu({ x: e.clientX, y: e.clientY, kind: "session", session: s });
                  }}
                  className={`group border-b border-hairline px-4 py-2.5 text-sm ${
                    selecting || clickable ? "cursor-pointer hover:bg-white/5" : "opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {selecting && (
                      <input
                        type="checkbox"
                        checked={checked.has(skey(s))}
                        onChange={() => toggleChecked(s)}
                        onClick={(e) => e.stopPropagation()}
                        className="mr-1 shrink-0"
                      />
                    )}
                    {s.pinned && <span title="已保留">⚑</span>}
                    <span className="truncate font-medium text-l1">{sessionTitle(s)}</span>
                    {(s.live || liveSessions[s.sessionId]) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          jumpToLive(s.sessionId);
                        }}
                        disabled={!liveSessions[s.sessionId]}
                        title={
                          liveSessions[s.sessionId]
                            ? "该会话正在终端里进行，点击跳转到对应标签"
                            : "该会话的 CLI 进程仍在运行（外部探测，无本地标签）"
                        }
                        className="shrink-0 rounded bg-ok px-1.5 py-0.5 text-xs text-ok-text disabled:opacity-80"
                      >
                        🟢 进行中
                      </button>
                    )}
                    {s.chainCount > 1 && (
                      <span className="shrink-0 rounded bg-inset px-1 text-xs text-l3">
                        {s.chainCount} 次继续
                      </span>
                    )}
                    {!s.alive && (
                      <span className="shrink-0 rounded bg-warn px-1 text-xs text-warn-text">
                        已失效
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-l3">
                    <span>{relTime(s.updatedAt)}</span>
                    <span>{agentLabel(s.agent)}</span>
                    {s.workspace && (
                      <span
                        className="rounded bg-inset px-1 text-l3"
                        title={`工作区「${s.workspace}」的会话`}
                      >
                        ⎇ {s.workspace}
                      </span>
                    )}
                    <span className="truncate">{basename(s.projectPath)}</span>
                    {s.tokenUsage && <span>{fmtTokens(s.tokenUsage)}</span>}
                    {s.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-inset px-1 text-l3"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className={`mt-1 gap-3 text-xs ${selecting ? "hidden" : "hidden group-hover:flex"}`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void togglePin(s);
                      }}
                      className="text-l3 hover:text-l1"
                    >
                      {s.pinned ? "取消保留" : "保留"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleArchive(s);
                      }}
                      className="text-l3 hover:text-l1"
                    >
                      {s.archived ? "取消归档" : "归档"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing({
                          agent: s.agent,
                          sessionId: s.sessionId,
                          title: s.customTitle ?? "",
                          tags: s.tags.join(", "),
                        });
                      }}
                      className="text-l2 hover:text-l1"
                    >
                      编辑
                    </button>
                    <button
                      disabled={!s.alive && !s.pinned}
                      onClick={(e) => {
                        e.stopPropagation();
                        resumeInTerminal(s);
                      }}
                      title={
                        s.alive || s.pinned
                          ? "在终端里恢复这个会话"
                          : "会话文件已失效且无快照，无法恢复"
                      }
                      className="text-l3 hover:text-l1 disabled:opacity-50"
                    >
                      恢复
                    </button>
                  </div>
                </div>
              );
            })}
            {sessionList.length === 0 && (
              <p className="p-4 text-sm text-l4">
                {showArchived ? "暂无会话" : "暂无会话（已归档的被隐藏）"}
              </p>
            )}
          </div>
        </div>

        {/* 对话回放 */}
        {selected && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 bg-strip px-4 py-2">
              <button
                onClick={() => {
                  setSelected(null);
                  setMessages([]);
                  setSummary(null);
                  setExportPath(null);
                  setReplayTab("chat");
                }}
                className="shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5"
              >
                ← 返回
              </button>
              <span className="truncate text-sm font-medium text-l1">
                {sessionTitle(selected)}
              </span>
              {selected.live && (
                <span
                  className="shrink-0 rounded bg-ok px-1.5 py-0.5 text-xs text-ok-text"
                  title="该会话的 CLI 进程仍在运行（外部探测）"
                >
                  🟢 进行中
                </span>
              )}
              <span className="shrink-0 text-xs text-l3">
                {agentLabel(selected.agent)} · {relTime(selected.updatedAt)}
                {selected.tokenUsage ? ` · ${fmtTokens(selected.tokenUsage)}` : ""}
              </span>
              <button
                onClick={() => resumeInTerminal(selected)}
                className="shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5"
              >
                在终端恢复
              </button>
              <button
                onClick={onSummarize}
                disabled={aiSummarizing}
                title="AI 生成会话摘要"
                className={`shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 disabled:opacity-50 ${
                  aiSummarizing ? "animate-pulse" : ""
                }`}
              >
                {aiSummarizing ? "◈ 摘要中…" : "◈ 摘要"}
              </button>
              <button
                onClick={onExport}
                disabled={exporting}
                title="导出会话为 Markdown 到 ~/Downloads/ccode-exports/"
                className="shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
              >
                {exporting ? "导出中…" : "导出"}
              </button>
              <button
                onClick={() => void togglePin(selected)}
                className="ml-auto shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5"
              >
                {selected.pinned ? "取消保留" : "⚑ 保留"}
              </button>
              {/* 对话 / 改动 页签 */}
              <div className="flex shrink-0 gap-1">
                {(["chat", "diff"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setReplayTab(k)}
                    className={`rounded px-2.5 py-1 text-xs ${
                      replayTab === k ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                    }`}
                  >
                    {k === "chat" ? "对话" : "改动"}
                  </button>
                ))}
              </div>
            </div>
            {error && <p className="px-4 py-1 text-xs text-err-text">{error}</p>}
            {exportPath && (
              <p className="truncate px-4 py-1 text-xs text-l4" title={exportPath}>
                已导出：{exportPath}
              </p>
            )}
            {replayTab === "diff" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <GitPanel
                  cwd={selected.projectPath}
                  visible={replayTab === "diff"}
                  onTotals={NOOP_TOTALS}
                />
              </div>
            ) : (
              <>
                {summary && (
                  <div className="mx-4 mt-2 rounded bg-inset p-3 text-sm text-l2">
                    <span className="mr-1">◈</span>
                    <span className="whitespace-pre-wrap">{summary}</span>
                  </div>
                )}
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
                  {loadingConv ? (
                    <p className="text-sm text-l4">加载中…</p>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-l4">没有可回放的对话内容</p>
                  ) : (
                    <ConversationView messages={messages} />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 右键菜单：fixed 遮罩 + 光标处浮层 */}
      {menu && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="absolute min-w-36 rounded border border-field bg-strip py-1 text-sm"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {menu.kind === "session" ? (
              <>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    void togglePin(menu.session);
                  }}
                >
                  {menu.session.pinned ? "取消保留" : "保留"}
                </button>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    void toggleArchive(menu.session);
                  }}
                >
                  {menu.session.archived ? "取消归档" : "归档"}
                </button>
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenu(null);
                    // 编辑表单在列表栏，先退出回放态
                    setSelected(null);
                    setEditing({
                      agent: menu.session.agent,
                      sessionId: menu.session.sessionId,
                      title: menu.session.customTitle ?? "",
                      tags: menu.session.tags.join(", "),
                    });
                  }}
                >
                  编辑
                </button>
                {(menu.session.alive || menu.session.pinned) && (
                  <button
                    className={menuItem}
                    onClick={() => {
                      setMenu(null);
                      resumeInTerminal(menu.session);
                    }}
                  >
                    在终端恢复
                  </button>
                )}
                <button
                  className={`${menuItem} text-err-text`}
                  onClick={() => {
                    setMenu(null);
                    void deleteSession(menu.session);
                  }}
                >
                  删除会话
                </button>
              </>
            ) : (
              <button
                className={`${menuItem} text-err-text`}
                onClick={() => {
                  setMenu(null);
                  void deleteProjectSessions(menu.agent, menu.path, menu.count);
                }}
              >
                删除该项目全部会话
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
