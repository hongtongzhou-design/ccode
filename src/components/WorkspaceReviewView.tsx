import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FolderClosed,
  FolderOpen,
  GitBranch,
  RefreshCw,
  Search,
} from "lucide-react";
import ContextMenu from "./ContextMenu";
import { LoadingRows } from "./PageFrame";
import type {
  GitCommitResultDto,
  GitFileDto,
  WorkspaceDiffDto,
  WorkspaceDto,
  WorkspaceHealthDto,
  WorkspaceMergeResultDto,
  WorkspacePrResultDto,
} from "../types";

interface GitStatusDto {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileDto[];
  totalAdd: number;
  totalDel: number;
}

interface UnmergedDto {
  merging: boolean;
  files: string[];
  staleBase: boolean;
}

interface ConflictContentDto {
  ours: string | null;
  theirs: string | null;
  diff: string;
  truncated: boolean;
}

interface ConflictAdviceDto {
  path: string;
  choice: "ours" | "theirs" | "manual";
  reason: string;
}

type ConflictChoice = "ours" | "theirs";

type FinishMode = "commit" | "merge" | "merge-archive" | "archive";

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

interface FoldedDiffBlock {
  kind: "fold";
  id: string;
  rows: DiffLine[];
}

type DisplayDiffRow = DiffLine | FoldedDiffBlock;

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

function parseHunkStart(
  line: string,
): { oldStart: number; newStart: number } | null {
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
    <div
      className={`grid min-w-0 grid-cols-[44px_minmax(max-content,1fr)] ${tone}`}
    >
      <span className="select-none border-r border-hairline px-2 text-right text-l4">
        {lineNo ?? ""}
      </span>
      <span className="whitespace-pre px-2">{text || " "}</span>
    </div>
  );
}

function foldContextRows(
  rows: DiffLine[],
  expanded: ReadonlySet<string>,
): DisplayDiffRow[] {
  const output: DisplayDiffRow[] = [];
  let context: DiffLine[] = [];
  let foldIndex = 0;
  const flush = () => {
    if (context.length <= 12) {
      output.push(...context);
    } else {
      const id = `fold-${foldIndex++}`;
      if (expanded.has(id)) {
        output.push(...context);
      } else {
        output.push(...context.slice(0, 3));
        output.push({ kind: "fold", id, rows: context.slice(3, -3) });
        output.push(...context.slice(-3));
      }
    }
    context = [];
  };

  for (const row of rows) {
    if (
      row.kind === "line" &&
      row.oldKind === "context" &&
      row.newKind === "context"
    ) {
      context.push(row);
    } else {
      flush();
      output.push(row);
    }
  }
  flush();
  return output;
}

function DiffTable({
  rows,
  minWidth = 720,
}: {
  rows: DiffLine[];
  minWidth?: number;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const displayRows = useMemo(
    () => foldContextRows(rows, expanded),
    [expanded, rows],
  );

  useEffect(() => {
    setExpanded(new Set());
  }, [rows]);

  return (
    <div className="overflow-x-auto bg-canvas font-mono text-[11px] leading-5">
      {displayRows.map((row, index) => {
        if (row.kind === "fold") {
          return (
            <button
              key={row.id}
              type="button"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  next.add(row.id);
                  return next;
                })
              }
              className="flex h-7 w-full items-center justify-center border-y border-hairline bg-inset text-l4 hover:bg-seg-sel hover:text-l2"
            >
              展开 {row.rows.length} 行未修改内容
            </button>
          );
        }
        if (row.kind === "hunk") {
          return (
            <div
              key={`${row.header}-${index}`}
              className="flex h-6 items-center border-y border-hairline bg-inset px-3 text-l4"
            >
              {row.header}
            </div>
          );
        }
        return (
          <div
            key={index}
            className="grid grid-cols-2 divide-x divide-hairline"
            style={{ minWidth }}
          >
            <DiffSide
              lineNo={row.oldNo}
              text={row.oldText}
              kind={row.oldKind}
            />
            <DiffSide
              lineNo={row.newNo}
              text={row.newText}
              kind={row.newKind}
            />
          </div>
        );
      })}
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
  }, [file.path, register, worktreePath]);

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
      className="border-b-4 border-strip bg-canvas"
    >
      <div className="sticky top-0 z-[1] flex h-10 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        <span className={`font-mono ${STATUS_STYLE[file.status] ?? "text-l3"}`}>
          {file.status === "??" ? "U" : file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono font-medium text-l1">
          {file.path}
        </span>
        {file.additions !== null && (
          <span className="font-mono text-add">+{file.additions}</span>
        )}
        {file.deletions !== null && file.deletions > 0 && (
          <span className="font-mono text-del">-{file.deletions}</span>
        )}
      </div>
      {!visible || text === null ? (
        <div className="min-h-28 px-4 py-3">
          {error ? (
            <p className="text-xs text-err-text">{error}</p>
          ) : (
            <LoadingRows compact />
          )}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-5 text-xs text-l4">无可显示的文本差异</p>
      ) : (
        <DiffTable rows={rows} minWidth={680} />
      )}
    </section>
  );
}

function ChangeTree({
  nodes,
  onSelect,
  activePath,
  depth = 0,
}: {
  nodes: ChangeTreeNode[];
  onSelect: (path: string) => void;
  activePath: string | null;
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
              className={`flex h-7 w-full items-center gap-1.5 border-l-2 pr-2 text-left text-xs hover:bg-white/5 ${
                !isDir && activePath === node.path
                  ? "border-cta bg-rail-sel text-l1"
                  : "border-transparent text-l2"
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {isDir ? (
                <>
                  {isClosed ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 text-l4"
                    />
                  ) : (
                    <ChevronDown
                      aria-hidden="true"
                      className="h-3 w-3 shrink-0 text-l4"
                    />
                  )}
                  {isClosed ? (
                    <FolderClosed
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-l3"
                    />
                  ) : (
                    <FolderOpen
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-l3"
                    />
                  )}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <File
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-l3"
                  />
                </>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {node.file && (
                <>
                  <span
                    className={`font-mono ${STATUS_STYLE[node.file.status] ?? "text-l3"}`}
                  >
                    {node.file.status === "??" ? "U" : node.file.status}
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                </>
              )}
            </button>
            {isDir && !isClosed && (
              <ChangeTree
                nodes={node.children}
                onSelect={onSelect}
                activePath={activePath}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function ConflictFileSection({
  path,
  content,
  contentError,
  branch,
  baseBranch,
  unresolved,
  choice,
  advice,
  busy,
  register,
  onChoose,
  onRetry,
}: {
  path: string;
  content: ConflictContentDto | null;
  contentError: string | undefined;
  branch: string;
  baseBranch: string;
  unresolved: boolean;
  choice: ConflictChoice | undefined;
  advice: ConflictAdviceDto | undefined;
  busy: boolean;
  register: (path: string, element: HTMLElement | null) => void;
  onChoose: (path: string, choice: ConflictChoice) => void;
  onRetry: (path: string) => void;
}) {
  const rows = useMemo(
    () => (content ? parseDiff(content.diff) : []),
    [content],
  );
  return (
    <section
      ref={(element) => register(path, element)}
      className="border-b-4 border-strip bg-canvas"
    >
      <div className="sticky top-0 z-[2] border-b border-hairline bg-strip">
        <div className="flex h-10 items-center gap-2 px-3 text-xs">
          <span
            className={`font-mono ${unresolved ? "text-err-text" : "text-okb"}`}
          >
            {unresolved ? "U" : "✓"}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono font-medium text-l1">
            {path}
          </span>
          {choice && (
            <span className="rounded bg-inset px-2 py-0.5 text-l2">
              已选 {choice === "ours" ? "任务版" : baseBranch}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 divide-x divide-hairline border-t border-hairline text-xs">
          <div
            className={`flex min-w-0 items-center gap-2 border-t-2 px-3 py-1.5 ${
              choice === "ours"
                ? "border-cta bg-cta-pill"
                : "border-transparent"
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-l2">
              任务分支 · {branch}
            </span>
            <button
              type="button"
              onClick={() => onChoose(path, "ours")}
              disabled={!content || !unresolved || busy}
              className={`rounded border px-2 py-0.5 disabled:opacity-50 ${
                choice === "ours"
                  ? "border-cta-bd bg-cta text-cta-text"
                  : "border-field bg-inset text-l2 hover:bg-seg-sel hover:text-l1"
              }`}
            >
              {choice === "ours" ? "已选" : "选用"}
            </button>
          </div>
          <div
            className={`flex min-w-0 items-center gap-2 border-t-2 px-3 py-1.5 ${
              choice === "theirs"
                ? "border-cta bg-cta-pill"
                : "border-transparent"
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-l2">
              基准分支 · {baseBranch}
            </span>
            <button
              type="button"
              onClick={() => onChoose(path, "theirs")}
              disabled={!content || !unresolved || busy}
              className={`rounded border px-2 py-0.5 disabled:opacity-50 ${
                choice === "theirs"
                  ? "border-cta-bd bg-cta text-cta-text"
                  : "border-field bg-inset text-l2 hover:bg-seg-sel hover:text-l1"
              }`}
            >
              {choice === "theirs" ? "已选" : "选用"}
            </button>
          </div>
        </div>
        {advice && (
          <div className="flex min-h-8 items-center gap-2 border-t border-hairline bg-inset px-3 py-1 text-xs">
            <span className="shrink-0 text-l1">◈</span>
            <span className="shrink-0 text-l2">
              {advice.choice === "ours"
                ? "建议任务版"
                : advice.choice === "theirs"
                  ? `建议 ${baseBranch}`
                  : "建议人工合并"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-l4"
              title={advice.reason}
            >
              {advice.reason}
            </span>
            {unresolved &&
              (advice.choice === "ours" || advice.choice === "theirs") && (
                <button
                  type="button"
                  onClick={() =>
                    onChoose(path, advice.choice as ConflictChoice)
                  }
                  disabled={busy}
                  className="shrink-0 rounded px-2 py-0.5 text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
                >
                  按建议
                </button>
              )}
          </div>
        )}
      </div>

      {contentError ? (
        <div className="min-h-36 px-4 py-5 text-xs text-err-text">
          <p>加载两侧内容失败：{contentError}</p>
          <button
            type="button"
            onClick={() => onRetry(path)}
            className="mt-2 rounded bg-btn px-2 py-1 text-l1 hover:bg-white/10"
          >
            重试加载
          </button>
        </div>
      ) : !content ? (
        <div className="min-h-36 px-4 py-4">
          <LoadingRows compact />
        </div>
      ) : rows.length === 0 ? (
        <div className="grid min-h-36 grid-cols-2 divide-x divide-hairline font-mono text-[11px] leading-5">
          <pre className="overflow-auto whitespace-pre p-3 text-l2">
            {content.ours ?? "（此侧已删除）"}
          </pre>
          <pre className="overflow-auto whitespace-pre p-3 text-l2">
            {content.theirs ?? "（此侧已删除）"}
          </pre>
        </div>
      ) : (
        <DiffTable rows={rows} />
      )}
      {content?.truncated && (
        <div className="border-t border-hairline bg-inset px-3 py-2 text-xs text-warn-text">
          文件较大，当前只显示前 512
          KB；需要逐行编辑时请在预览编辑器中打开该文件。
        </div>
      )}
    </section>
  );
}

export default function WorkspaceReviewView({
  worktreePath,
  initialAction = null,
  initialActionKey = null,
  onClose,
}: {
  worktreePath: string;
  /** pr/archive 定位对应弹层；resolve-conflict 表示「解决冲突」入口，允许自动准备冲突两侧。 */
  initialAction?: "pr" | "archive" | "resolve-conflict" | null;
  /** 同一工作区的重复“更多操作”请求也必须重新打开相应弹层。 */
  initialActionKey?: string | null;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<WorkspaceDiffDto | null>(null);
  const [status, setStatus] = useState<GitStatusDto | null>(null);
  const [health, setHealth] = useState<WorkspaceHealthDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const signatureRef = useRef("");
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const reviewMainRef = useRef<HTMLElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const autoConflictRef = useRef<string | null>(null);
  const prTitleInitRef = useRef<string | null>(null);
  // 点击树定位后短暂抑制滚动同步，避免 smooth 滚动途中 activePath 被改回
  const suppressTrackRef = useRef(false);
  const suppressTrackTimerRef = useRef<number | null>(null);
  const [mergedAt, setMergedAt] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [finishMenu, setFinishMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [showBlockers, setShowBlockers] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBusy, setPrBusy] = useState(false);
  const [prDrafting, setPrDrafting] = useState(false);
  const [prPushed, setPrPushed] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prCopied, setPrCopied] = useState(false);
  const initialActionRef = useRef<string | null>(null);
  const [unmerged, setUnmerged] = useState<UnmergedDto | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [conflictContents, setConflictContents] = useState<
    Record<string, ConflictContentDto>
  >({});
  const [conflictContentErrors, setConflictContentErrors] = useState<
    Record<string, string>
  >({});
  const [conflictChoices, setConflictChoices] = useState<
    Record<string, ConflictChoice>
  >({});
  const [conflictAdvice, setConflictAdvice] = useState<
    Record<string, ConflictAdviceDto>
  >({});
  const [conflictBusy, setConflictBusy] = useState(false);
  const [adviceBusy, setAdviceBusy] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const [nextDiff, nextStatus] = await Promise.all([
          invoke<WorkspaceDiffDto>("workspace_diff", { worktreePath }),
          invoke<GitStatusDto>("git_status", { cwd: worktreePath }),
        ]);
        if (!nextDiff.inWorkspace) throw new Error("该目录不属于活动工作区");
        const [nextHealth, nextUnmerged] = await Promise.all([
          invoke<WorkspaceHealthDto>("workspace_health", {
            id: nextDiff.workspaceId,
          }),
          invoke<UnmergedDto>("workspace_unmerged_files", {
            id: nextDiff.workspaceId,
          }),
        ]);
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
        setUnmerged(nextUnmerged);
        if (nextUnmerged.merging && nextUnmerged.files.length > 0) {
          setConflictFiles((current) =>
            current.length > 0 ? current : nextUnmerged.files,
          );
        }
        if (!quiet) setError(null);
      } catch (reason) {
        // 静默轮询失败不覆盖用户正在看的错误，避免留下清不掉的粘性横幅
        if (!quiet) setError(String(reason));
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
    signatureRef.current = "";
    autoConflictRef.current = null;
    prTitleInitRef.current = null;
    suppressTrackRef.current = false;
    if (suppressTrackTimerRef.current !== null) {
      window.clearTimeout(suppressTrackTimerRef.current);
      suppressTrackTimerRef.current = null;
    }
    sectionRefs.current.clear();
    setMergedAt(null);
    setUnmerged(null);
    setConflictFiles([]);
    setConflictContents({});
    setConflictContentErrors({});
    setConflictChoices({});
    setConflictAdvice({});
    setFileQuery("");
    setActivePath(null);
    initialActionRef.current = null;
  }, [worktreePath]);

  // merged_at 不在 diff/health DTO 上，按工作区单独取一次，用于「已合并」按钮态
  useEffect(() => {
    const workspaceId = diff?.workspaceId;
    if (!workspaceId) return;
    invoke<WorkspaceDto[]>("list_workspaces")
      .then((list) => {
        setMergedAt(
          list.find((workspace) => workspace.id === workspaceId)?.mergedAt ??
            null,
        );
      })
      .catch(() => {});
  }, [diff?.workspaceId]);

  // 工作区列表的“在评审中创建 PR / 归档”只负责定位到此处；真正执行仍要求在覆盖层内确认。
  useEffect(() => {
    if (!initialAction || !diff) return;
    const key = `${initialActionKey ?? initialAction}:${initialAction}:${diff.workspaceId}`;
    if (initialActionRef.current === key) return;
    initialActionRef.current = key;
    if (initialAction === "pr") setPrOpen(true);
    else if (initialAction === "archive") setArchiveOpen(true);
  }, [diff, initialAction, initialActionKey]);

  // PR 标题只按工作区初始化一次，之后允许用户清空重写
  useEffect(() => {
    if (!diff || prTitleInitRef.current === diff.workspaceId) return;
    prTitleInitRef.current = diff.workspaceId;
    setPrTitle(diff.workspaceName);
  }, [diff]);

  // 「解决冲突」本身就是明确操作：工作区干净时直接准备最新基准两侧，
  // 不先展示容易被误认为当前 main 的普通 merge-base diff。
  // 自动准备只绑定「解决冲突」入口；普通「审阅」入口不得仅因打开就把 worktree 置入 MERGING。
  useEffect(() => {
    if (
      initialAction !== "resolve-conflict" ||
      !diff ||
      health?.conflict !== true ||
      !status ||
      !unmerged ||
      unmerged.merging ||
      status.files.length > 0 ||
      busy ||
      conflictBusy
    ) {
      return;
    }
    if (autoConflictRef.current === diff.workspaceId) return;
    autoConflictRef.current = diff.workspaceId;
    void startConflictResolution(false);
  }, [busy, conflictBusy, diff, health?.conflict, initialAction, status, unmerged]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!busy && !conflictBusy) void refresh(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [busy, conflictBusy, refresh]);

  useEffect(() => {
    if (!diff || !unmerged?.merging || unmerged.staleBase) return;
    const paths = conflictFiles.length > 0 ? conflictFiles : unmerged.files;
    const missing = paths.filter(
      (path) => !conflictContents[path] && !conflictContentErrors[path],
    );
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (path) => {
        try {
          const content = await invoke<ConflictContentDto>(
            "workspace_conflict_content",
            {
              id: diff.workspaceId,
              path,
            },
          );
          return { path, content, error: null };
        } catch (reason) {
          return { path, content: null, error: String(reason) };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const entries = results
        .filter(
          (item): item is typeof item & { content: ConflictContentDto } =>
            !!item.content,
        )
        .map((item) => [item.path, item.content] as const);
      const errors = results
        .filter((item) => item.error)
        .map((item) => [item.path, item.error!] as const);
      if (entries.length > 0) {
        setConflictContents((current) => ({
          ...current,
          ...Object.fromEntries(entries),
        }));
      }
      if (errors.length > 0) {
        setConflictContentErrors((current) => ({
          ...current,
          ...Object.fromEntries(errors),
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conflictContentErrors, conflictContents, conflictFiles, diff, unmerged]);

  const blockers = blockerText(health);
  const conflictMode = unmerged?.merging === true;
  const staleBase = unmerged?.staleBase === true;
  const unresolvedFiles = unmerged?.files ?? [];
  const unresolvedSet = useMemo(
    () => new Set(unresolvedFiles),
    [unresolvedFiles],
  );
  const allConflictContentsLoaded =
    conflictFiles.length > 0 &&
    conflictFiles.every((path) => !!conflictContents[path]);
  const hasUncommitted = (status?.files.length ?? 0) > 0;
  const hasCommitted = (health?.ahead ?? 0) > 0;
  const hasTaskChanges = (diff?.files.length ?? 0) > 0;
  const hardBlocked = blockers.length > 0;
  // 约定：merged_at && ahead == 0 时合并按钮显示禁用的「已合并」，
  // 新提交令 ahead > 0 后恢复「合并」
  const primaryLabel = hasUncommitted
    ? "提交并合并"
    : hasCommitted
      ? "合并"
      : mergedAt
        ? "已合并"
        : "无待合并提交";
  const canPrimary =
    !busy &&
    !hardBlocked &&
    (hasUncommitted ? message.trim().length > 0 : hasCommitted);
  const normalizedQuery = fileQuery.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () =>
      (diff?.files ?? []).filter(
        (file) =>
          !normalizedQuery ||
          file.path.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [diff?.files, normalizedQuery],
  );
  const tree = useMemo(() => buildChangeTree(filteredFiles), [filteredFiles]);
  const filteredConflictFiles = useMemo(
    () =>
      conflictFiles.filter(
        (path) =>
          !normalizedQuery ||
          path.toLocaleLowerCase().includes(normalizedQuery),
      ),
    [conflictFiles, normalizedQuery],
  );
  const displayedPaths = conflictMode
    ? filteredConflictFiles
    : filteredFiles.map((file) => file.path);

  useEffect(() => {
    if (displayedPaths.length === 0) return;
    if (!activePath || !displayedPaths.includes(activePath))
      setActivePath(displayedPaths[0]);
  }, [activePath, displayedPaths]);

  const registerSection = useCallback(
    (path: string, element: HTMLElement | null) => {
      if (element) sectionRefs.current.set(path, element);
      else sectionRefs.current.delete(path);
    },
    [],
  );

  function selectFile(path: string) {
    setActivePath(path);
    suppressTrackRef.current = true;
    if (suppressTrackTimerRef.current !== null)
      window.clearTimeout(suppressTrackTimerRef.current);
    suppressTrackTimerRef.current = window.setTimeout(() => {
      suppressTrackRef.current = false;
      suppressTrackTimerRef.current = null;
    }, 600);
    sectionRefs.current
      .get(path)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const trackActiveFile = useCallback(() => {
    if (suppressTrackRef.current) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const host = reviewMainRef.current;
      if (!host) return;
      const threshold = host.getBoundingClientRect().top + 56;
      let next: string | null = null;
      for (const [path, element] of sectionRefs.current) {
        const top = element.getBoundingClientRect().top;
        if (top <= threshold) next = path;
        else if (!next) {
          next = path;
          break;
        }
      }
      if (next) setActivePath((current) => (current === next ? current : next));
    });
  }, []);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null)
        window.cancelAnimationFrame(scrollFrameRef.current);
      if (suppressTrackTimerRef.current !== null)
        window.clearTimeout(suppressTrackTimerRef.current);
    },
    [],
  );

  function retryConflictContent(path: string) {
    setConflictContentErrors((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setConflictContents((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  async function startConflictResolution(restart = false) {
    if (!diff) return;
    if (
      restart &&
      !window.confirm(
        `${diff.baseBranch} 已在冲突开始后更新。重新同步会放弃当前尚未提交的选边结果，并用最新 ${diff.baseBranch} 重新生成冲突。继续？`,
      )
    ) {
      return;
    }
    setConflictBusy(true);
    setFinishMenu(null);
    setError(null);
    setResult(null);
    // 新一轮同步（restart，或从非 MERGING 状态首次进入）一律清掉上一轮
    // 选边与两侧内容，避免把上一轮的选边徽标带进新冲突
    if (restart || !unmerged?.merging) {
      setConflictFiles([]);
      setConflictContents({});
      setConflictContentErrors({});
      setConflictChoices({});
      setConflictAdvice({});
    }
    try {
      const output = await invoke<string>("workspace_sync_base", {
        id: diff.workspaceId,
        restart,
      });
      setResult(output);
    } catch (reason) {
      const state = await invoke<UnmergedDto>("workspace_unmerged_files", {
        id: diff.workspaceId,
      }).catch(() => null);
      if (!state?.merging) {
        setError(String(reason));
        return;
      }
      setUnmerged(state);
      setConflictFiles(state.files);
      setResult(
        `冲突已放在隔离工作区中，请逐个比较 ${diff.branch} 与 ${diff.baseBranch} 后选定版本`,
      );
    } finally {
      await refresh(true);
      setConflictBusy(false);
    }
  }

  async function chooseConflict(path: string, choice: ConflictChoice) {
    if (!diff) return;
    setConflictBusy(true);
    setError(null);
    try {
      const state = await invoke<UnmergedDto>("workspace_resolve_file", {
        id: diff.workspaceId,
        path,
        side: choice,
      });
      setUnmerged(state);
      setConflictChoices((current) => ({ ...current, [path]: choice }));
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function chooseAll(choice: ConflictChoice) {
    if (!diff || unresolvedFiles.length === 0) return;
    if (
      choice === "theirs" &&
      !window.confirm(
        `将全部冲突文件改为 ${diff.baseBranch} 版本，任务分支对应改动会被放弃。继续？`,
      )
    )
      return;
    setConflictBusy(true);
    setError(null);
    try {
      let state = unmerged;
      for (const path of unresolvedFiles) {
        state = await invoke<UnmergedDto>("workspace_resolve_file", {
          id: diff.workspaceId,
          path,
          side: choice,
        });
        // 逐条更新选边，中途失败时已解决的文件仍保留徽标
        setConflictChoices((current) => ({ ...current, [path]: choice }));
      }
      setUnmerged(state);
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function requestConflictAdvice() {
    if (!diff) return;
    setAdviceBusy(true);
    setError(null);
    try {
      const list = await invoke<ConflictAdviceDto[]>("ai_conflict_advice", {
        id: diff.workspaceId,
      });
      setConflictAdvice(
        Object.fromEntries(list.map((item) => [item.path, item])),
      );
    } catch (reason) {
      setError(`${reason}（AI 只给建议，不会自动选择版本）`);
    } finally {
      setAdviceBusy(false);
    }
  }

  async function applyConflictAdvice() {
    if (!diff) return;
    const choices = unresolvedFiles
      .map((path) => [path, conflictAdvice[path]?.choice] as const)
      .filter(
        (entry): entry is readonly [string, ConflictChoice] =>
          entry[1] === "ours" || entry[1] === "theirs",
      );
    if (choices.length === 0) return;
    setConflictBusy(true);
    setError(null);
    try {
      let state = unmerged;
      for (const [path, choice] of choices) {
        state = await invoke<UnmergedDto>("workspace_resolve_file", {
          id: diff.workspaceId,
          path,
          side: choice,
        });
        // 逐条更新选边，中途失败时已解决的文件仍保留徽标
        setConflictChoices((current) => ({ ...current, [path]: choice }));
      }
      setUnmerged(state);
      await refresh(true);
    } catch (reason) {
      setError(String(reason));
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function finishConflict(mergeAfter: boolean) {
    if (!diff) return;
    if (unresolvedFiles.length > 0) {
      setError(`还有 ${unresolvedFiles.length} 个冲突文件未选择版本`);
      return;
    }
    if (
      mergeAfter &&
      !window.confirm(
        `将提交冲突解决结果并合并进本地 ${diff.baseBranch}，工作区保留且不推送。继续？`,
      )
    )
      return;
    setConflictBusy(true);
    setError(null);
    setResult(null);
    let resolvedCommitted = false;
    try {
      await invoke<string>("workspace_finish_merge", { id: diff.workspaceId });
      resolvedCommitted = true;
      if (!mergeAfter) {
        setResult("冲突解决结果已提交，可稍后继续审阅并合并");
        await refresh();
        return;
      }
      const latest = await invoke<WorkspaceHealthDto>("workspace_health", {
        id: diff.workspaceId,
      });
      if (!latest.readyToMerge) {
        const reasons = blockerText(latest);
        if (latest.uncommitted) reasons.unshift("工作区仍有未提交改动");
        throw new Error(reasons.join("；") || "健康检查未通过");
      }
      const merged = await invoke<WorkspaceMergeResultDto>("merge_workspace", {
        id: diff.workspaceId,
        archive: false,
      });
      if (merged.failedPhase) throw new Error(merged.message);
      setResult(merged.message);
      setMergedAt(new Date().toISOString());
      setConflictFiles([]);
      setConflictContents({});
      setConflictContentErrors({});
      setConflictChoices({});
      setConflictAdvice({});
      await refresh();
    } catch (reason) {
      setError(
        `${resolvedCommitted ? "解决结果已提交，但最终合并未完成：" : ""}${reason}`,
      );
      await refresh(true);
    } finally {
      setConflictBusy(false);
    }
  }

  async function generateMessage() {
    setAiBusy(true);
    setError(null);
    try {
      setMessage(
        (
          await invoke<string>("ai_commit_message", { cwd: worktreePath })
        ).trim(),
      );
    } catch (reason) {
      setError(`${reason}（检查设置页「AI 专用配置」是否可用）`);
    } finally {
      setAiBusy(false);
    }
  }

  async function draftPr() {
    if (!diff) return;
    if (
      prBody.trim() &&
      !window.confirm("将用 AI 起草覆盖当前 PR 描述，继续？")
    )
      return;
    setPrDrafting(true);
    setError(null);
    try {
      setPrBody(await invoke<string>("ai_draft_pr", { id: diff.workspaceId }));
    } catch (reason) {
      setError(`${reason}（检查设置页“AI 专用配置”是否可用）`);
    } finally {
      setPrDrafting(false);
    }
  }

  async function submitPr() {
    if (!diff || !prTitle.trim()) return;
    setPrBusy(true);
    setError(null);
    try {
      const created = await invoke<WorkspacePrResultDto>("create_pr", {
        id: diff.workspaceId,
        title: prTitle.trim(),
        body: prBody.trim() || null,
        skipPush: prPushed,
      });
      setPrPushed(created.pushed);
      if (created.prCreated && created.prUrl) {
        setPrUrl(created.prUrl);
        setResult("PR 已创建");
      } else {
        setError(created.message);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPrBusy(false);
    }
  }

  function closePrDialog() {
    setPrOpen(false);
    setPrBody("");
    setPrPushed(false);
    setPrUrl(null);
    setPrCopied(false);
  }

  async function finish(mode: FinishMode) {
    if (!diff || !status || !health) return;
    const shouldCommit = status.files.length > 0;
    const shouldMerge = mode === "merge" || mode === "merge-archive";
    const shouldArchive = mode === "archive";
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
    if (
      shouldArchive &&
      !archiveOpen &&
      !window.confirm(
        `${shouldCommit ? "将提交当前全部改动，然后" : "将"}归档工作区。worktree 会被移除，分支仍保留以便恢复。继续？`,
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
        const commitResult = await invoke<GitCommitResultDto>("git_commit", {
          cwd: worktreePath,
          message: message.trim(),
          push: false,
        });
        if (!commitResult.committed) throw new Error(commitResult.message);
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
          throw new Error(
            `提交已完成，但尚不可合并：${reasons.join("；") || "健康检查未通过"}`,
          );
        }
        const mergeResult = await invoke<WorkspaceMergeResultDto>(
          "merge_workspace",
          {
            id: diff.workspaceId,
            archive,
          },
        );
        if (mergeResult.failedPhase) {
          setError(`${committed ? "提交已完成；" : ""}${mergeResult.message}`);
          await refresh(true);
          return;
        }
        setResult(mergeResult.message);
        if (mergeResult.archived) {
          onClose();
          return;
        }
        setMergedAt(new Date().toISOString());
      } else if (shouldArchive) {
        await invoke("archive_workspace", { id: diff.workspaceId });
        setResult("工作区已归档，分支仍可恢复");
        onClose();
        return;
      } else {
        setResult("改动已提交，可继续审阅或稍后合并");
      }
      await refresh();
    } catch (reason) {
      setError(
        `${committed && !String(reason).includes("提交已完成") ? "提交已完成；" : ""}${reason}`,
      );
      await refresh(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-canvas">
      <header className="shrink-0 border-b border-hairline bg-strip">
        <div className="flex h-12 items-center gap-3 px-3">
          <button
            type="button"
            onClick={onClose}
            title="返回终端"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-l1">
              {conflictMode || health?.conflict ? "解决冲突" : "审阅"}
            </span>
            <span className="text-l4">/</span>
            <span className="truncate text-sm text-l2">
              {diff?.workspaceName ?? "加载中"}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing || busy || conflictBusy}
              title="刷新审阅数据"
              className="flex h-8 w-8 items-center justify-center rounded text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
            >
              <RefreshCw
                aria-hidden="true"
                className={["h-4 w-4", refreshing ? "animate-spin" : ""].join(
                  " ",
                )}
              />
            </button>

            {diff && health?.conflict && !conflictMode ? (
              <button
                type="button"
                onClick={() =>
                  hasUncommitted
                    ? void finish("commit")
                    : void startConflictResolution()
                }
                disabled={
                  conflictBusy || busy || (hasUncommitted && !message.trim())
                }
                className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy || conflictBusy
                  ? "处理中…"
                  : hasUncommitted
                    ? "先提交改动"
                    : "开始解决冲突"}
              </button>
            ) : conflictMode ? (
              staleBase ? (
                <button
                  type="button"
                  onClick={() => void startConflictResolution(true)}
                  disabled={conflictBusy}
                  className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {conflictBusy
                    ? "重新同步中…"
                    : `重新同步最新 ${diff?.baseBranch ?? "基准分支"}`}
                </button>
              ) : (
                <div className="flex">
                  <button
                    type="button"
                    onClick={() => void finishConflict(true)}
                    disabled={conflictBusy || unresolvedFiles.length > 0}
                    className="min-w-36 rounded-l border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    {conflictBusy ? (
                      "处理中…"
                    ) : unresolvedFiles.length > 0 ? (
                      <>还剩 {unresolvedFiles.length} 个冲突</>
                    ) : (
                      "完成解决并合并"
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setFinishMenu({
                        x: rect.right - 190,
                        y: rect.bottom + 4,
                      });
                    }}
                    disabled={conflictBusy || unresolvedFiles.length > 0}
                    title="更多完成方式"
                    className="flex w-8 items-center justify-center rounded-r border-y border-r border-cta-bd bg-cta text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    <ChevronDown aria-hidden="true" className="h-4 w-4" />
                  </button>
                </div>
              )
            ) : (
              <div className="flex">
                <button
                  type="button"
                  onClick={() => void finish("merge")}
                  disabled={!canPrimary}
                  className="min-w-32 rounded-l border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? "处理中…" : primaryLabel}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setFinishMenu({ x: rect.right - 190, y: rect.bottom + 4 });
                  }}
                  disabled={busy}
                  title="更多完成方式"
                  className="flex w-8 items-center justify-center rounded-r border-y border-r border-cta-bd bg-cta text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {diff && (
          <div className="flex min-h-9 items-center gap-3 border-t border-hairline px-3 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2 text-l3">
              <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-44 truncate font-mono text-l2">
                {diff.branch}
              </span>
              <span className="text-l4">→</span>
              <span className="max-w-32 truncate font-mono">
                {diff.baseBranch}
              </span>
              <span className="ml-1 text-l4">{diff.files.length} 个文件</span>
              <span className="font-mono text-add">+{diff.totalAdd}</span>
              <span className="font-mono text-del">-{diff.totalDel}</span>
              {health && (
                <span className="font-mono text-l4">
                  ↑{health.ahead} ↓{health.behind}
                </span>
              )}
            </div>

            {conflictMode ? (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                <span className="mr-1 text-l4">
                  {conflictFiles.length - unresolvedFiles.length}/
                  {conflictFiles.length} 已选择
                </span>
                <button
                  type="button"
                  onClick={() => void chooseAll("ours")}
                  disabled={
                    staleBase ||
                    conflictBusy ||
                    unresolvedFiles.length === 0 ||
                    !allConflictContentsLoaded
                  }
                  className="rounded border border-field bg-inset px-2 py-1 text-l2 hover:bg-seg-sel hover:text-l1 disabled:opacity-50"
                >
                  全部任务版
                </button>
                <button
                  type="button"
                  onClick={() => void chooseAll("theirs")}
                  disabled={
                    staleBase ||
                    conflictBusy ||
                    unresolvedFiles.length === 0 ||
                    !allConflictContentsLoaded
                  }
                  className="rounded border border-field bg-inset px-2 py-1 text-l2 hover:bg-seg-sel hover:text-l1 disabled:opacity-50"
                >
                  全部 {diff.baseBranch}
                </button>
                <button
                  type="button"
                  onClick={() => void requestConflictAdvice()}
                  disabled={
                    staleBase ||
                    adviceBusy ||
                    conflictBusy ||
                    unresolvedFiles.length === 0
                  }
                  className="rounded border border-field bg-inset px-2 py-1 text-l2 hover:bg-seg-sel hover:text-l1 disabled:opacity-50"
                >
                  {adviceBusy ? "◈ 分析中…" : "◈ AI 建议"}
                </button>
                {Object.keys(conflictAdvice).length > 0 && (
                  <button
                    type="button"
                    onClick={() => void applyConflictAdvice()}
                    disabled={
                      staleBase || conflictBusy || !allConflictContentsLoaded
                    }
                    className="rounded px-2 py-1 text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
                  >
                    按建议选择
                  </button>
                )}
              </div>
            ) : hasUncommitted ? (
              <div className="ml-auto flex w-[360px] shrink-0 items-center gap-1.5">
                <input
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canPrimary)
                      void finish("merge");
                  }}
                  disabled={busy}
                  placeholder="提交信息"
                  className="min-w-0 flex-1 rounded border border-field bg-canvas px-2 py-1 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4"
                />
                <button
                  type="button"
                  onClick={() => void generateMessage()}
                  disabled={aiBusy || busy}
                  title="AI 生成提交信息"
                  className="flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-l2 hover:bg-white/5 disabled:opacity-50"
                >
                  {aiBusy ? "◈…" : "◈"}
                </button>
              </div>
            ) : (
              <span
                title={`默认只合并到本地 ${diff.baseBranch} 并保留工作区；不会自动推送远程`}
                className="ml-auto flex h-7 w-7 items-center justify-center rounded text-l4"
              >
                ⓘ
              </span>
            )}
          </div>
        )}
      </header>

      {diff && !conflictMode && blockers.length > 0 && (
        <div className="shrink-0 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-warn-text">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warnb" />
            <span className="min-w-0 flex-1">
              {blockers.length} 项问题需要处理
            </span>
            <button
              type="button"
              onClick={() => setShowBlockers((value) => !value)}
              className="rounded px-2 py-0.5 text-warn-text hover:bg-white/5"
            >
              {showBlockers ? "收起" : "查看"}
            </button>
          </div>
          {showBlockers && (
            <ul className="mt-1.5 space-y-1 border-t border-hairline pt-1.5 text-l3">
              {blockers.map((blocker) => (
                <li key={blocker}>• {blocker}</li>
              ))}
              {health?.conflict && health.conflictFiles.length > 0 && (
                <li>• 冲突文件：{health.conflictFiles.join("、")}</li>
              )}
            </ul>
          )}
        </div>
      )}
      {diff && conflictMode && staleBase && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-warn-text">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warnb" />
          <span>
            {diff.baseBranch}{" "}
            已在本次冲突开始后更新；旧的基准侧已停止显示，请从右上角重新同步。
          </span>
        </div>
      )}
      {result && (
        <div className="shrink-0 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-ok-text">
          ✓ {result}
        </div>
      )}
      {error && (
        <div className="shrink-0 border-b border-hairline bg-inset px-3 py-1.5 text-xs text-err-text">
          ✗ {error}
        </div>
      )}

      {loading && !diff ? (
        <div className="mx-auto w-full max-w-3xl px-8 py-8">
          <LoadingRows />
        </div>
      ) : !diff ? (
        <div className="p-6 text-sm text-err-text">
          {error ?? "无法加载工作区审阅数据"}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <main
            ref={reviewMainRef}
            onScroll={trackActiveFile}
            className="min-w-0 flex-1 overflow-auto bg-canvas"
          >
            {conflictMode ? (
              staleBase ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
                  <p className="text-sm text-l2">
                    当前冲突使用的是旧基准，已暂停展示两侧内容
                  </p>
                  <p className="max-w-xl text-xs text-l4">
                    重新同步后会基于最新 {diff.baseBranch} 生成新的任务版 /
                    基准版对照，避免看到一套内容、实际选择另一套内容。
                  </p>
                  <button
                    type="button"
                    onClick={() => void startConflictResolution(true)}
                    disabled={conflictBusy}
                    className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                  >
                    {conflictBusy
                      ? "重新同步中…"
                      : `重新同步最新 ${diff.baseBranch}`}
                  </button>
                </div>
              ) : conflictFiles.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-l4">
                  正在读取冲突文件…
                </div>
              ) : filteredConflictFiles.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-l4">
                  没有匹配的冲突文件
                </div>
              ) : (
                filteredConflictFiles.map((path) => (
                  <ConflictFileSection
                    key={path}
                    path={path}
                    content={conflictContents[path] ?? null}
                    contentError={conflictContentErrors[path]}
                    branch={diff.branch}
                    baseBranch={diff.baseBranch}
                    unresolved={unresolvedSet.has(path)}
                    choice={conflictChoices[path]}
                    advice={conflictAdvice[path]}
                    busy={conflictBusy || staleBase}
                    register={registerSection}
                    onChoose={(file, choice) =>
                      void chooseConflict(file, choice)
                    }
                    onRetry={retryConflictContent}
                  />
                ))
              )
            ) : health?.conflict ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <p className="text-sm text-l2">
                  {hasUncommitted
                    ? "先提交工作区改动，再准备最新基准"
                    : conflictBusy
                      ? `正在同步最新 ${diff.baseBranch}…`
                      : error
                        ? "同步失败，请从右上角重试"
                        : `与 ${diff.baseBranch} 存在冲突，可从右上角开始解决`}
                </p>
                <p className="max-w-xl text-xs text-l4">
                  冲突模式只会展示本次同步后真实的任务版和基准版，不再用普通
                  merge-base diff 代替当前基准内容。
                </p>
              </div>
            ) : !hasTaskChanges ? (
              <div className="flex h-full items-center justify-center text-sm text-l4">
                当前任务相对 {diff.baseBranch} 没有改动
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-l4">
                没有匹配的改动文件
              </div>
            ) : (
              filteredFiles.map((file) => (
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

          <aside className="flex w-[292px] shrink-0 flex-col border-l border-hairline bg-rail2">
            <div className="shrink-0 border-b border-hairline p-3">
              <div className="flex h-8 items-center gap-2 rounded border border-field bg-canvas px-2">
                <Search
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-l4"
                />
                <input
                  value={fileQuery}
                  onChange={(event) => setFileQuery(event.target.value)}
                  placeholder="筛选文件…"
                  className="min-w-0 flex-1 bg-transparent text-xs text-l2 outline-none placeholder:text-l4"
                />
                {fileQuery && (
                  <button
                    type="button"
                    onClick={() => setFileQuery("")}
                    className="text-l4 hover:text-l2"
                    title="清除筛选"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="mt-2 flex items-center text-[11px] text-l4">
                <span>{conflictMode ? "冲突文件" : "改动文件"}</span>
                <span className="ml-auto">
                  {conflictMode
                    ? filteredConflictFiles.length
                    : filteredFiles.length}
                  /{conflictMode ? conflictFiles.length : diff.files.length}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto py-1">
              {conflictMode ? (
                filteredConflictFiles.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-l4">没有匹配文件</p>
                ) : (
                  filteredConflictFiles.map((path) => {
                    const unresolved = unresolvedSet.has(path);
                    const choice = conflictChoices[path];
                    return (
                      <button
                        key={path}
                        type="button"
                        onClick={() => selectFile(path)}
                        title={path}
                        className={[
                          "flex min-h-8 w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-xs hover:bg-white/5",
                          activePath === path
                            ? "border-cta bg-rail-sel"
                            : "border-transparent",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "font-mono",
                            unresolved ? "text-err-text" : "text-okb",
                          ].join(" ")}
                        >
                          {unresolved ? "U" : "✓"}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-l2">
                          {path}
                        </span>
                        {choice && (
                          <span className="shrink-0 text-l4">
                            {choice === "ours" ? "任务" : diff.baseBranch}
                          </span>
                        )}
                      </button>
                    );
                  })
                )
              ) : tree.length === 0 ? (
                <p className="px-3 py-2 text-xs text-l4">没有匹配文件</p>
              ) : (
                <ChangeTree
                  nodes={tree}
                  onSelect={selectFile}
                  activePath={activePath}
                />
              )}
            </div>

            <div className="shrink-0 border-t border-hairline bg-strip px-3 py-2 text-[11px] text-l4">
              {conflictMode ? (
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "h-1.5 w-1.5 rounded-full",
                      staleBase
                        ? "bg-warnb"
                        : unresolvedFiles.length
                          ? "bg-err-text"
                          : "bg-okb",
                    ].join(" ")}
                  />
                  <span>
                    {staleBase ? (
                      `${diff.baseBranch} 已更新，等待重新同步`
                    ) : unresolvedFiles.length ? (
                      <>还剩 {unresolvedFiles.length} 个文件未选择</>
                    ) : (
                      "全部冲突文件已选择"
                    )}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "h-1.5 w-1.5 rounded-full",
                      hardBlocked ? "bg-warnb" : "bg-okb",
                    ].join(" ")}
                  />
                  <span>
                    {hardBlocked ? "处理顶部提示后继续" : "从右上角提交或合并"}
                  </span>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {finishMenu && !staleBase && (
        <ContextMenu
          x={finishMenu.x}
          y={finishMenu.y}
          onClose={() => setFinishMenu(null)}
          items={
            conflictMode
              ? [
                  {
                    label: "仅保存解决结果",
                    onSelect: () => void finishConflict(false),
                  },
                ]
              : [
                  ...(hasUncommitted
                    ? [
                        {
                          label: "仅提交",
                          onSelect: () => void finish("commit"),
                        },
                      ]
                    : []),
                  ...(!hardBlocked
                    ? [
                        {
                          label: "合并（保留工作区）",
                          onSelect: () => void finish("merge"),
                        },
                        {
                          label: "合并并归档",
                          onSelect: () => void finish("merge-archive"),
                        },
                      ]
                    : []),
                  ...(hasCommitted
                    ? [{ label: "创建 PR", onSelect: () => setPrOpen(true) }]
                    : []),
                  ...(!health?.conflict && !unmerged?.merging
                    ? [
                        {
                          label: "归档工作区",
                          onSelect: () => setArchiveOpen(true),
                        },
                      ]
                    : []),
                ]
          }
        />
      )}

      {prOpen && diff && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            // 请求在途时不响应遮罩关闭，避免关框重开导致重复建 PR
            if (!prBusy) closePrDialog();
          }}
        >
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void submitPr();
            }}
            className="w-full max-w-[26rem] rounded-md border border-field bg-strip p-5"
          >
            <h2 className="mb-1 text-base font-semibold text-l1">创建 PR</h2>
            <p
              className="mb-4 truncate font-mono text-xs text-l4"
              title={`${diff.branch} → ${diff.baseBranch}`}
            >
              {diff.branch} → {diff.baseBranch}
            </p>
            {prUrl ? (
              <div className="mb-4">
                <p className="mb-2 text-sm text-ok-text">✓ PR 已创建</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openUrl(prUrl)}
                    title={prUrl}
                    className="min-w-0 flex-1 truncate text-left text-sm text-l1 underline decoration-l4 underline-offset-2 hover:decoration-l1"
                  >
                    {prUrl}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(prUrl).then(() => {
                        setPrCopied(true);
                        window.setTimeout(() => setPrCopied(false), 1500);
                      });
                    }}
                    className="shrink-0 rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5"
                  >
                    {prCopied ? "已复制" : "复制"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="mb-3 block text-sm">
                  <span className="mb-1 block text-xs text-l3">标题</span>
                  <input
                    autoFocus
                    required
                    value={prTitle}
                    onChange={(event) => setPrTitle(event.target.value)}
                    className="w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                </label>
                <label className="mb-4 block text-sm">
                  <span className="mb-1 flex items-center justify-between">
                    <span className="text-xs text-l3">描述</span>
                    <button
                      type="button"
                      onClick={() => void draftPr()}
                      disabled={prDrafting}
                      title="AI 起草 PR 描述"
                      className="rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
                    >
                      {prDrafting ? "◈ 起草中…" : "◈ AI 起草"}
                    </button>
                  </span>
                  <textarea
                    value={prBody}
                    onChange={(event) => setPrBody(event.target.value)}
                    placeholder="留空自动生成提交摘要"
                    className="h-24 w-full resize-y rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                  />
                </label>
                {error && <p className="mb-3 text-xs text-err-text">{error}</p>}
              </>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closePrDialog}
                className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
              >
                {prUrl ? "关闭" : "取消"}
              </button>
              {!prUrl && (
                <button
                  type="submit"
                  disabled={prBusy || !prTitle.trim()}
                  className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {prBusy ? "创建中…" : prPushed ? "重试创建 PR" : "创建 PR"}
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {archiveOpen && diff && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            // 请求在途时不响应遮罩关闭，避免关框重开导致重复提交/归档
            if (!busy) setArchiveOpen(false);
          }}
        >
          <form
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void finish("archive");
            }}
            className="w-full max-w-[26rem] rounded-md border border-field bg-strip p-5"
          >
            <h2 className="mb-2 text-base font-semibold text-l1">
              {hasUncommitted ? "提交并归档" : "归档工作区"}
            </h2>
            <p className="mb-4 text-xs text-l3">
              {hasUncommitted
                ? `先将改动提交到 ${diff.branch}，再移除工作树；分支仍保留以便恢复。`
                : "worktree 会被移除，分支仍保留以便恢复。"}
            </p>
            {hasUncommitted && (
              <label className="mb-4 block">
                <span className="mb-1 block text-xs text-l3">提交信息</span>
                <input
                  autoFocus
                  required
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  disabled={busy}
                  placeholder={`chore: 保存 ${diff.workspaceName}`}
                  className="w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
                />
              </label>
            )}
            {error && <p className="mb-3 text-xs text-err-text">✗ {error}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArchiveOpen(false)}
                disabled={busy}
                className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy || (hasUncommitted && !message.trim())}
                className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {busy
                  ? "处理中…"
                  : hasUncommitted
                    ? "提交并归档"
                    : "归档工作区"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
