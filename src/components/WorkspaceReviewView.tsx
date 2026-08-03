import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FolderClosed,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import ContextMenu from "./ContextMenu";
import { LoadingRows } from "./PageFrame";
import type { GitFileDto, WorkspaceDiffDto, WorkspaceHealthDto } from "../types";

interface GitStatusDto {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

type FinishMode = "commit" | "merge" | "merge-archive";

interface DiffLine {
  kind: "line" | "hunk";
  header?: string;
  oldNo: number | null;
  newNo: number | null;
  oldText: string;
  newText: string;
  oldKind: "context" | "delete" | "blank";
  newKind: "context" | "add" | "blank";
}

interface ChangeTreeNode {
  name: string;
  path: string;
  children: ChangeTreeNode[];
  file: GitFileDto | null;
}

const STATUS_STYLE: Record<string, string> = {
  M: "text-warn-text",
  A: "text-add",
  "??": "text-add",
  D: "text-del",
  R: "text-l2",
};

function parseHunkStart(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function parseDiff(text: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  let removed: string[] = [];
  let added: string[] = [];

  const flushChanged = () => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) {
      const oldText = removed[i];
      const newText = added[i];
      rows.push({
        kind: "line",
        oldNo: oldText === undefined ? null : oldNo++,
        newNo: newText === undefined ? null : newNo++,
        oldText: oldText ?? "",
        newText: newText ?? "",
        oldKind: oldText === undefined ? "blank" : "delete",
        newKind: newText === undefined ? "blank" : "add",
      });
    }
    removed = [];
    added = [];
  };

  for (const line of text.split("\n")) {
    const hunk = parseHunkStart(line);
    if (hunk) {
      flushChanged();
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      rows.push({
        kind: "hunk",
        header: line,
        oldNo: null,
        newNo: null,
        oldText: "",
        newText: "",
        oldKind: "blank",
        newKind: "blank",
      });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      flushChanged();
      const value = line.slice(1);
      rows.push({
        kind: "line",
        oldNo: oldNo++,
        newNo: newNo++,
        oldText: value,
        newText: value,
        oldKind: "context",
        newKind: "context",
      });
    }
  }
  flushChanged();
  return rows;
}

function buildChangeTree(files: GitFileDto[]): ChangeTreeNode[] {
  const root: ChangeTreeNode = { name: "", path: "", children: [], file: null };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      let child = node.children.find((entry) => entry.name === part);
      if (!child) {
        const path = parts.slice(0, index + 1).join("/");
        child = { name: part, path, children: [], file: null };
        node.children.push(child);
      }
      node = child;
    });
    node.file = file;
  }
  const sort = (nodes: ChangeTreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = a.children.length > 0;
      const bDir = b.children.length > 0;
      return aDir === bDir ? a.name.localeCompare(b.name) : aDir ? -1 : 1;
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  return root.children;
}

function blockerText(health: WorkspaceHealthDto | null): string[] {
  if (!health) return [];
  const blockers: string[] = [];
  if (health.conflict === true) blockers.push("与基准分支存在冲突");
  if (health.conflict === null) blockers.push("当前 Git 版本无法预检冲突");
  if (health.mainDirty) blockers.push("主仓库有未提交改动");
  if (health.mainOffBase) blockers.push("主仓库不在基准分支");
  return blockers;
}

function DiffSide({
  lineNo,
  text,
  kind,
}: {
  lineNo: number | null;
  text: string;
  kind: "context" | "add" | "delete" | "blank";
}) {
  const tone =
    kind === "add"
      ? "bg-ok text-add"
      : kind === "delete"
        ? "bg-err text-del"
        : kind === "blank"
          ? "bg-inset/40 text-l4"
          : "text-l2";
  return (
    <div className={`grid min-w-0 grid-cols-[44px_minmax(max-content,1fr)] ${tone}`}>
      <span className="select-none border-r border-hairline px-2 text-right text-l4">
        {lineNo ?? ""}
      </span>
      <span className="whitespace-pre px-2">{text || " "}</span>
    </div>
  );
}

function DiffFileSection({
  file,
  worktreePath,
  revision,
  register,
}: {
  file: GitFileDto;
  worktreePath: string;
  revision: number;
  register: (path: string, element: HTMLElement | null) => void;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return;
    register(file.path, element);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      register(file.path, null);
    };
  }, [file.path, register]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setText(null);
    setError(null);
    invoke<string>("workspace_file_diff", { worktreePath, path: file.path })
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, revision, visible, worktreePath]);

  const rows = useMemo(() => (text == null ? [] : parseDiff(text)), [text]);
  return (
    <section
      ref={(element) => {
        sectionRef.current = element;
      }}
      className="border-b border-hairline"
    >
      <div className="sticky top-0 z-[1] flex h-9 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        <span className={`font-mono ${STATUS_STYLE[file.status] ?? "text-l3"}`}>
          {file.status === "??" ? "U" : file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-l2">{file.path}</span>
        {file.additions !== null && <span className="font-mono text-add">+{file.additions}</span>}
        {file.deletions !== null && file.deletions > 0 && (
          <span className="font-mono text-del">-{file.deletions}</span>
        )}
      </div>
      {!visible || text === null ? (
        <div className="min-h-28 px-4 py-3">
          {error ? <p className="text-xs text-err-text">{error}</p> : <LoadingRows compact />}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-5 text-xs text-l4">无可显示的文本差异</p>
      ) : (
        <div className="overflow-x-auto bg-canvas font-mono text-[11px] leading-5">
          {rows.map((row, index) =>
            row.kind === "hunk" ? (
              <div key={`${row.header}-${index}`} className="border-y border-hairline bg-inset px-3 text-l4">
                {row.header}
              </div>
            ) : (
              <div key={index} className="grid min-w-[620px] grid-cols-2 divide-x divide-hairline">
                <DiffSide lineNo={row.oldNo} text={row.oldText} kind={row.oldKind} />
                <DiffSide lineNo={row.newNo} text={row.newText} kind={row.newKind} />
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ChangeTree({
  nodes,
  onSelect,
  depth = 0,
}: {
  nodes: ChangeTreeNode[];
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return (
    <>
      {nodes.map((node) => {
        const isDir = node.children.length > 0;
        const isClosed = collapsed.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => {
                if (isDir) {
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                } else {
                  onSelect(node.path);
                }
              }}
              title={node.path}
              className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-xs text-l2 hover:bg-white/5"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {isDir ? (
                <>
                  {isClosed ? (
                    <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-l4" />
                  ) : (
                    <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-l4" />
                  )}
                  {isClosed ? (
                    <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l3" />
                  ) : (
                    <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l3" />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l3" />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.file && (
                <>
                  <span className={`font-mono ${STATUS_STYLE[node.file.status] ?? "text-l3"}`}>
                    {node.file.status === "??" ? "U" : node.file.status}
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                </>
              )}
            </button>
            {isDir && !isClosed && (
              <ChangeTree nodes={node.children} onSelect={onSelect} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

export default function WorkspaceReviewView({
  worktreePath,
  onClose,
  onOpenConflict,
}: {
  worktreePath: string;
  onClose: () => void;
  onOpenConflict: (workspaceId: string) => void;
}) {
  const [diff, setDiff] = useState<WorkspaceDiffDto | null>(null);
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [health, setHealth] = useState<WorkspaceHealthDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const signatureRef = useRef("");
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [finishMenu, setFinishMenu] = useState<{ x: number; y: number } | null>(null);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const [nextDiff, nextStatus] = await Promise.all([
          invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath }),
          invoke<GitStatusDto>("git_status", { cwd: worktreePath }),
        ]);
        if (!nextDiff.inWorkspace) throw new Error("该目录不属于活动工作区");
        const nextHealth = await invoke<WorkspaceHealthDto>("workspace_health", {
          id: nextDiff.workspaceId,
        });
        const signature = JSON.stringify({
          files: nextDiff.files,
          status: nextStatus.files,
          health: nextHealth,
        });
        if (signature !== signatureRef.current) {
          signatureRef.current = signature;
          setRevision((value) => value + 1);
        }
        setDiff(nextDiff);
        setStatus(nextStatus);
        setHealth(nextHealth);
        setError(null);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [worktreePath],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy) void refresh(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [busy, refresh]);

  const tree = useMemo(() => buildChangeTree(diff?.files ?? []), [diff?.files]);
  const blockers = blockerText(health);
  const hasUncommitted = (status?.files.length ?? 0) > 0;
  const hasCommitted = (health?.ahead ?? 0) > 0;
  const hasTaskChanges = (diff?.files.length ?? 0) > 0;
  const hardBlocked = blockers.length > 0;
  const primaryLabel = hasUncommitted
    ? "提交并合并"
    : hasCommitted
      ? "合并"
      : result
        ? "已完成"
        : "无待合并提交";
  const canPrimary =
    !busy &&
    !hardBlocked &&
    (hasUncommitted ? message.trim().length > 0 : hasCommitted);

  const registerSection = useCallback((path: string, element: HTMLElement | null) => {
    if (element) sectionRefs.current.set(path, element);
    else sectionRefs.current.delete(path);
  }, []);

  function selectFile(path: string) {
    sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function generateMessage() {
    setAiBusy(true);
    setError(null);
    try {
      setMessage((await invoke<string>("ai_commit_message", { cwd: worktreePath })).trim());
    } catch (reason) {
      setError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setAiBusy(false);
    }
  }

  async function finish(mode: FinishMode) {
    if (!diff || !status || !health) return;
    const shouldCommit = status.files.length > 0;
    const shouldMerge = mode !== "commit";
    const archive = mode === "merge-archive";
    if (shouldCommit && !message.trim()) {
      setError("请先填写提交信息");
      return;
    }
    if (
      shouldMerge &&
      !window.confirm(
        `${shouldCommit ? "将提交当前全部改动，然后" : "将"}把 ${diff.branch} 合并进 ${diff.baseBranch}${
          archive ? "并归档工作区" : "（保留工作区）"
        }。继续？`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    let committed = false;
    try {
      if (shouldCommit) {
        await invoke<string>("git_commit", {
          cwd: worktreePath,
          message: message.trim(),
          push: false,
        });
        committed = true;
        setMessage("");
      }
      if (shouldMerge) {
        const latest = await invoke<WorkspaceHealthDto>("workspace_health", {
          id: diff.workspaceId,
        });
        if (!latest.readyToMerge) {
          const reasons = blockerText(latest);
          if (latest.uncommitted) reasons.unshift("工作区仍有未提交改动");
          throw new Error(`提交已完成，但尚不可合并：${reasons.join("；") || "健康检查未通过"}`);
        }
        await invoke<string>("merge_workspace", { id: diff.workspaceId, archive });
        setResult(archive ? "任务已提交、合并并归档" : "任务已提交并合并，工作区已保留");
        if (archive) {
          onClose();
          return;
        }
      } else {
        setResult("改动已提交，可继续审阅或稍后合并");
      }
      await refresh();
    } catch (reason) {
      setError(`${committed && !String(reason).includes("提交已完成") ? "提交已完成；" : ""}${reason}`);
      await refresh(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-strip px-3">
        <button
          type="button"
          onClick={onClose}
          title="返回终端"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium text-l1">{diff?.workspaceName ?? "任务审阅"}</span>
            {diff && (
              <span className="truncate font-mono text-xs text-l3">
                {diff.branch} → {diff.baseBranch}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-l4">
            <span>{diff?.files.length ?? 0} 个文件</span>
            <span className="font-mono text-add">+{diff?.totalAdd ?? 0}</span>
            <span className="font-mono text-del">-{diff?.totalDel ?? 0}</span>
            {health && (
              <span>
                ↑{health.ahead} ↓{health.behind}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing || busy}
          title="刷新审阅数据"
          className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
        >
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </header>

      {loading && !diff ? (
        <div className="mx-auto w-full max-w-3xl px-8 py-8">
          <LoadingRows />
        </div>
      ) : !diff ? (
        <div className="p-6 text-sm text-err-text">{error ?? "无法加载工作区审阅数据"}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-auto bg-canvas">
            {!hasTaskChanges ? (
              <div className="flex h-full items-center justify-center text-sm text-l4">
                当前任务相对 {diff.baseBranch} 没有改动
              </div>
            ) : (
              diff.files.map((file) => (
                <DiffFileSection
                  key={file.path}
                  file={file}
                  worktreePath={diff.worktreePath}
                  revision={revision}
                  register={registerSection}
                />
              ))
            )}
          </main>

          <aside className="flex w-[300px] shrink-0 flex-col border-l border-hairline bg-strip">
            <div className="flex h-10 shrink-0 items-center border-b border-hairline px-3 text-xs font-medium text-l2">
              改动文件
              <span className="ml-auto text-l4">{diff.files.length}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {tree.length === 0 ? (
                <p className="px-3 py-2 text-xs text-l4">没有改动文件</p>
              ) : (
                <ChangeTree nodes={tree} onSelect={selectFile} />
              )}
            </div>

            <div className="shrink-0 border-t border-hairline bg-canvas p-3">
              {blockers.length > 0 && (
                <div className="mb-3 bg-inset p-2 text-xs text-warn-text">
                  {blockers.map((blocker) => (
                    <div key={blocker}>• {blocker}</div>
                  ))}
                  {health?.conflict && (
                    <button
                      type="button"
                      onClick={() => onOpenConflict(diff.workspaceId)}
                      className="mt-2 rounded bg-btn px-2 py-1 text-l1 hover:bg-white/10"
                    >
                      处理冲突
                    </button>
                  )}
                </div>
              )}
              {hasUncommitted && (
                <div className="mb-2 flex items-center gap-1.5">
                  <input
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && canPrimary) void finish("merge");
                    }}
                    disabled={busy}
                    placeholder="提交信息"
                    className="min-w-0 flex-1 rounded border border-field bg-inset px-2 py-1.5 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                  <button
                    type="button"
                    onClick={() => void generateMessage()}
                    disabled={aiBusy || busy}
                    title="AI 生成提交信息"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-l2 hover:bg-white/5 disabled:opacity-50"
                  >
                    {aiBusy ? "◈…" : "◈"}
                  </button>
                </div>
              )}
              <div className="flex">
                <button
                  type="button"
                  onClick={() => void finish("merge")}
                  disabled={!canPrimary}
                  className="min-w-0 flex-1 rounded-l border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? "处理中…" : primaryLabel}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setFinishMenu({ x: rect.right - 190, y: rect.top - 78 });
                  }}
                  disabled={busy || (!hasUncommitted && (!hasCommitted || hardBlocked))}
                  title="更多完成方式"
                  className="flex w-8 items-center justify-center rounded-r border-y border-r border-cta-bd bg-cta text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2 text-[11px] text-l4">
                默认合并到本地 {diff.baseBranch}，工作区保留；不会自动推送远程
              </p>
              {result && <div className="mt-2 bg-inset p-2 text-xs text-ok-text">✓ {result}</div>}
              {error && <div className="mt-2 bg-inset p-2 text-xs text-err-text">✗ {error}</div>}
            </div>
          </aside>
        </div>
      )}

      {finishMenu && (
        <ContextMenu
          x={finishMenu.x}
          y={finishMenu.y}
          onClose={() => setFinishMenu(null)}
          items={[
            ...(hasUncommitted
              ? [{ label: "仅提交", onSelect: () => void finish("commit") }]
              : []),
            ...(!hardBlocked
              ? [
                  { label: "合并（保留工作区）", onSelect: () => void finish("merge") },
                  { label: "合并并归档", onSelect: () => void finish("merge-archive") },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
