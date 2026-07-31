import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import type { ChatMessageDto, SessionMetaDto, TokenUsageDto } from "../types";

type Filter =
  | { kind: "all" }
  | { kind: "agent"; agent: string }
  | { kind: "project"; path: string };

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [showArchived, setShowArchived] = useState(false);
  // 分类树里收起的 agent（默认全部展开）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  editingRef.current = editing !== null;
  const selectedRef = useRef<SessionMetaDto | null>(null);
  selectedRef.current = selected;

  const q = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!q) return sessions;
    return sessions.filter((s) =>
      [s.projectPath, s.title ?? "", s.customTitle ?? "", ...s.tags]
        .join("\n")
        .toLowerCase()
        .includes(q),
    );
  }, [sessions, q]);

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
      src = src.filter((s) => s.projectPath === filter.path);
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
        ? basename(filter.path)
        : "全部会话";

  async function openSession(s: SessionMetaDto) {
    // 源文件已删除且无快照，无法回放
    if (!s.alive && !s.pinned) return;
    setSelected(s);
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

  // 页面可见时每 5s 轮询；当前打开的会话 updatedAt 变了就重拉对话
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
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, loadSessions]);

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
    "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500";

  const filterActive = (f: Filter) =>
    (filter.kind === "all" && f.kind === "all") ||
    (filter.kind === "agent" && f.kind === "agent" && filter.agent === f.agent) ||
    (filter.kind === "project" && f.kind === "project" && filter.path === f.path);

  return (
    <div className="flex h-full">
      {/* 左栏：分类树 */}
      <div className="flex w-[230px] shrink-0 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-2">
          <input
            className={input}
            placeholder="搜索项目 / 会话 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          <button
            onClick={() => selectFilter({ kind: "all" })}
            className={`block w-full px-3 py-1.5 text-left text-sm ${
              filterActive({ kind: "all" })
                ? "bg-blue-50 text-blue-700"
                : "hover:bg-neutral-100"
            }`}
          >
            全部会话
            <span className="ml-1 text-xs text-neutral-400">{searched.length}</span>
          </button>
          {tree.map((g) => (
            <div key={g.agent}>
              <div
                onClick={() => selectFilter({ kind: "agent", agent: g.agent })}
                className={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-sm ${
                  filterActive({ kind: "agent", agent: g.agent })
                    ? "bg-blue-50 text-blue-700"
                    : "hover:bg-neutral-100"
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapsed(g.agent);
                    selectFilter({ kind: "agent", agent: g.agent });
                  }}
                  className="mr-1 shrink-0 text-neutral-400"
                  title={collapsed.has(g.agent) ? "展开" : "收起"}
                >
                  {collapsed.has(g.agent) ? "▸" : "▾"}
                </button>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate font-medium">{agentLabel(g.agent)}</span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {g.list.length}
                  </span>
                </span>
              </div>
              {!collapsed.has(g.agent) &&
                g.projects.map((p) => (
                  <button
                    key={p.path}
                    onClick={() => selectFilter({ kind: "project", path: p.path })}
                    title={p.path}
                    className={`flex w-full items-center justify-between gap-2 py-1.5 pl-8 pr-3 text-left text-sm ${
                      filterActive({ kind: "project", path: p.path })
                        ? "bg-blue-50 text-blue-700"
                        : "hover:bg-neutral-100"
                    }`}
                  >
                    <span className="truncate">{basename(p.path)}</span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {p.list.length}
                    </span>
                  </button>
                ))}
            </div>
          ))}
          {tree.length === 0 && (
            <p className="p-3 text-sm text-neutral-400">暂无会话</p>
          )}
        </div>
        <label className="flex items-center gap-1.5 border-t border-neutral-200 px-3 py-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          显示已归档
        </label>
      </div>

      {/* 右栏：列表 / 回放 二选一（列表保持挂载以保留滚动与筛选） */}
      <div className="flex min-w-0 flex-1 flex-col bg-neutral-50">
        {/* 会话列表 */}
        <div className={`flex min-h-0 flex-1 flex-col ${selected ? "hidden" : ""}`}>
          {error && <p className="px-4 py-1 text-xs text-red-600">{error}</p>}
          <div className="border-b border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-500">
            {filterLabel} · {sessionList.length} 个会话
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {sessionList.map((s) => {
              const isEditing =
                editing?.agent === s.agent && editing.sessionId === s.sessionId;
              if (isEditing && editing) {
                return (
                  <div
                    key={s.sessionId}
                    className="space-y-2 border-b border-neutral-200 bg-white p-4"
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
                        className="text-neutral-600 hover:underline"
                      >
                        取消
                      </button>
                      <button onClick={saveEdit} className="text-blue-600 hover:underline">
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
                  onClick={() => openSession(s)}
                  className={`group border-b border-neutral-200 bg-white px-4 py-3 text-sm ${
                    clickable ? "cursor-pointer hover:bg-neutral-50" : "opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {s.pinned && <span title="已保留">📌</span>}
                    <span className="truncate font-medium">{sessionTitle(s)}</span>
                    {s.chainCount > 1 && (
                      <span className="shrink-0 rounded bg-neutral-100 px-1 text-xs text-neutral-600">
                        {s.chainCount} 次继续
                      </span>
                    )}
                    {!s.alive && (
                      <span className="shrink-0 rounded bg-amber-100 px-1 text-xs text-amber-700">
                        已失效
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
                    <span>{relTime(s.updatedAt)}</span>
                    <span>{agentLabel(s.agent)}</span>
                    <span className="truncate">{basename(s.projectPath)}</span>
                    {s.tokenUsage && <span>{fmtTokens(s.tokenUsage)}</span>}
                    {s.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-neutral-100 px-1 text-neutral-500"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 hidden gap-3 text-xs group-hover:flex">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void togglePin(s);
                      }}
                      className="text-neutral-600 hover:underline"
                    >
                      {s.pinned ? "取消保留" : "保留"}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleArchive(s);
                      }}
                      className="text-neutral-600 hover:underline"
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
                      className="text-blue-600 hover:underline"
                    >
                      编辑
                    </button>
                  </div>
                </div>
              );
            })}
            {sessionList.length === 0 && (
              <p className="p-4 text-sm text-neutral-400">
                {showArchived ? "暂无会话" : "暂无会话（已归档的被隐藏）"}
              </p>
            )}
          </div>
        </div>

        {/* 对话回放 */}
        {selected && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2">
              <button
                onClick={() => {
                  setSelected(null);
                  setMessages([]);
                }}
                className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
              >
                ← 返回
              </button>
              <span className="truncate text-sm font-medium">
                {sessionTitle(selected)}
              </span>
              <span className="shrink-0 text-xs text-neutral-400">
                {agentLabel(selected.agent)} · {relTime(selected.updatedAt)}
                {selected.tokenUsage ? ` · ${fmtTokens(selected.tokenUsage)}` : ""}
              </span>
              <button
                onClick={() => void togglePin(selected)}
                className="ml-auto shrink-0 rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
              >
                {selected.pinned ? "取消保留" : "📌 保留"}
              </button>
            </div>
            {error && <p className="px-4 py-1 text-xs text-red-600">{error}</p>}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4">
              {loadingConv ? (
                <p className="text-sm text-neutral-400">加载中…</p>
              ) : messages.length === 0 ? (
                <p className="text-sm text-neutral-400">没有可回放的对话内容</p>
              ) : (
                <ConversationView messages={messages} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
