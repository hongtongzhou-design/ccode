import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  ChevronRight,
  Folder,
  FolderOpen,
  Maximize2,
  MessageSquare,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { beginAskAi } from "./AskAiModal";
import type { DirEntryDto, SearchResultDto } from "./FileTree";
import {
  ghostActionClass,
  iconActionClass,
  projectWellClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import FileKindFilters from "./FileKindFilters";
import { IS_WINDOWS } from "../hotkeys";
import { pathWithin } from "../path-utils";
import {
  fileMatchesProjectFilter,
  flattenVisibleFiles,
  neighborFile,
  projectFilePreviewKind,
  type ProjectFileFilter,
} from "../project-files";
import { officeKindCounts } from "../project-status";
import type { OfficeDocDto, RunDto, TaskDto, TaskOutputChangeDto } from "../types";
import {
  declaredTaskKindsForMode,
  markForProjectFile,
  relativeProjectPath,
  visibleDeclaredTasks,
} from "../project-tasks";
import { goalReviewCopy } from "../goal-review";
import FileTypeMark from "./FileTypeMark";
import ProjectFilePreview from "./ProjectFilePreview";
import { Modal } from "./Modal";

type EntryCache = Record<string, DirEntryDto[]>;

function asFileEntry(file: {
  path: string;
  name: string;
  size?: number;
  modified?: string | null;
}): DirEntryDto {
  return {
    path: file.path,
    name: file.name,
    isDir: false,
    size: file.size ?? 0,
    modified: file.modified ?? null,
  };
}

export default function ProjectFilesView({
  projectPath,
  workMode,
  preferredAgent,
  preferredProfile,
  onError,
}: {
  projectPath: string;
  workMode?: string | null;
  preferredAgent?: string | null;
  preferredProfile?: string | null;
  onError: (message: string) => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const [cache, setCache] = useState<EntryCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<DirEntryDto | null>(null);
  const [windowed, setWindowed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectFileFilter>("all");
  const [officeDocs, setOfficeDocs] = useState<OfficeDocDto[]>([]);
  const [searchHits, setSearchHits] = useState<SearchResultDto[] | null>(null);
  const [goalMarks, setGoalMarks] = useState<
    { relative: string; goalName: string; pending: boolean }[]
  >([]);
  const pendingMark = goalReviewCopy(workMode).fileMark;
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (path: string) => {
    try {
      const entries = await invoke<DirEntryDto[]>("list_dir", {
        path,
        showHidden: false,
      });
      setCache((current) => ({ ...current, [path]: entries }));
    } catch (reason) {
      onError(`读取项目文件失败：${String(reason)}`);
    }
  }, [onError]);

  useEffect(() => {
    setCache({});
    setExpanded(new Set());
    setPreview(null);
    setWindowed(false);
    setQuery("");
    setFilter("all");
    setSearchHits(null);
    setLoading(true);
    void load(projectPath).finally(() => setLoading(false));
    void invoke<OfficeDocDto[]>("list_office_docs", { root: projectPath })
      .then(setOfficeDocs)
      .catch(() => setOfficeDocs([]));
    const kinds = declaredTaskKindsForMode(workMode);
    if (kinds.size === 0) {
      setGoalMarks([]);
    } else {
      void Promise.all([
        invoke<TaskDto[]>("task_list", { projectRoot: projectPath }),
        invoke<RunDto[]>("run_list", { projectRoot: projectPath }),
      ])
        .then(async ([tasks, runs]) => {
          const declared = visibleDeclaredTasks(tasks, kinds);
          const latest = new Map<string, RunDto>();
          for (const run of runs) {
            if (!latest.has(run.taskId)) latest.set(run.taskId, run);
          }
          const marks: { relative: string; goalName: string; pending: boolean }[] = [];
          for (const task of declared) {
            if (task.status !== "pending_review") continue;
            const run = latest.get(task.id);
            if (!run || run.status !== "completed") continue;
            try {
              const changes = await invoke<TaskOutputChangeDto[]>("task_output_changes", {
                runId: run.id,
              });
              for (const change of changes) {
                marks.push({
                  relative: change.path,
                  goalName: task.name,
                  pending: true,
                });
              }
            } catch {
              /* 读不到变更时不标 */
            }
          }
          setGoalMarks(marks);
        })
        .catch(() => setGoalMarks([]));
    }
  }, [load, projectPath, workMode]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    const timer = window.setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", {
        root: projectPath,
        query: q,
        showHidden: false,
      })
        .then(setSearchHits)
        .catch(() => setSearchHits([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [projectPath, query]);

  const filtering = filter !== "all" || !!query.trim();
  const kindCounts = useMemo(
    () => officeKindCounts(officeDocs.map((doc) => doc.path)),
    [officeDocs],
  );

  const filteredFiles = useMemo(() => {
    if (searchHits) {
      return searchHits.filter(
        (hit) => !hit.isDir && fileMatchesProjectFilter(hit.path, filter),
      );
    }
    if (filter === "all") return [];
    const q = query.trim().toLowerCase();
    return officeDocs.filter((doc) => {
      if (!fileMatchesProjectFilter(doc.path, filter)) return false;
      if (!q) return true;
      return (
        doc.name.toLowerCase().includes(q) || doc.rel.toLowerCase().includes(q)
      );
    });
  }, [filter, officeDocs, query, searchHits]);

  const visibleFiles = useMemo(() => {
    if (filtering) {
      return filteredFiles.map((file) => asFileEntry(file));
    }
    return flattenVisibleFiles(cache, projectPath, expanded);
  }, [cache, expanded, filteredFiles, filtering, projectPath]);

  const prevFile = neighborFile(visibleFiles, preview?.path, -1);
  const nextFile = neighborFile(visibleFiles, preview?.path, 1);

  async function toggle(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!cache[path]) await load(path);
    }
    setExpanded(next);
  }

  function openFile(entry: DirEntryDto) {
    setPreview(entry);
    setWindowed(false);
  }

  const visibleFilesRef = useRef(visibleFiles);
  visibleFilesRef.current = visibleFiles;
  const previewPathRef = useRef(preview?.path);
  previewPathRef.current = preview?.path;

  function openPath(absPath: string) {
    const name = absPath.split(/[\\/]/).pop() ?? absPath;
    setPreview({ path: absPath, name, isDir: false, size: 0, modified: null });
  }

  function stepPreview(delta: -1 | 1) {
    const next = neighborFile(
      visibleFilesRef.current,
      previewPathRef.current,
      delta,
    );
    if (!next) return;
    setPreview(asFileEntry(next));
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("[data-file-path]")) {
      active.blur();
    }
  }

  function askAi(entry: DirEntryDto) {
    beginAskAi({
      path: entry.path,
      name: entry.name,
      cwd: projectPath,
      root: projectPath,
      reuseKey: `project-file:${projectPath}:${entry.path}`,
      preferredAgent,
      preferredProfile,
    });
  }

  function readPdf(entry: DirEntryDto) {
    setReaderReq({ pdfPath: entry.path, projectRoot: projectPath });
    setPage("terminal");
  }

  useEffect(() => {
    if (!preview) return;
    const node = listRef.current?.querySelector(
      `[data-file-path="${CSS.escape(preview.path)}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input[type='search']")) return;
      const next = neighborFile(
        visibleFilesRef.current,
        previewPathRef.current,
        event.key === "ArrowUp" ? -1 : 1,
      );
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setPreview(asFileEntry(next));
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-file-path]")) {
        active.blur();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  function goalMarkFor(absPath: string) {
    return markForProjectFile(relativeProjectPath(projectPath, absPath), goalMarks);
  }

  function renderEntries(root: string, depth: number): ReactNode {
    const entries = cache[root] ?? [];
    return entries.map((entry) => {
      const open = expanded.has(entry.path);
      const selected = !entry.isDir && preview?.path === entry.path;
      return (
        <li key={entry.path}>
          <div
            className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 ${
              selected ? "bg-hover" : "hover:bg-hover"
            }`}
            style={{ paddingLeft: 8 + depth * 16 }}
          >
            {entry.isDir ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2"
                onClick={() => void toggle(entry.path)}
                aria-expanded={open}
              >
                <ChevronRight
                  size={13}
                  className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
                {open ? (
                  <FolderOpen size={14} className="shrink-0 text-folder" />
                ) : (
                  <Folder size={14} className="shrink-0 text-folder" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2 outline-none focus:outline-none focus-visible:outline-none"
                data-file-path={entry.path}
                onClick={() => openFile(entry)}
                title={entry.path}
              >
                <span className="w-[13px] shrink-0" />
                <FileTypeMark path={entry.path} />
                <span className="truncate">{entry.name}</span>
                {goalMarkFor(entry.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
              </button>
            )}
            <span className="absolute inset-y-0 right-1 hidden items-center bg-hover pl-1 group-hover:flex group-focus-within:flex">
              <button
                type="button"
                className={iconActionClass}
                title={entry.isDir ? "打开终端" : "问 AI"}
                aria-label={entry.isDir ? "打开终端" : "问 AI"}
                onClick={() => {
                  if (entry.isDir) {
                    setEnterCwdReq(entry.path);
                    setPage("terminal");
                  } else {
                    askAi(entry);
                  }
                }}
              >
                {entry.isDir ? (
                  <SquareTerminal size={13} strokeWidth={1.8} />
                ) : (
                  <MessageSquare size={13} strokeWidth={1.8} />
                )}
              </button>
              {/\.pdf$/i.test(entry.name) && (
                <button
                  type="button"
                  className={iconActionClass}
                  title="沉浸阅读"
                  aria-label="沉浸阅读"
                  onClick={() => readPdf(entry)}
                >
                  <BookOpen size={13} strokeWidth={1.8} />
                </button>
              )}
              <button
                type="button"
                className={iconActionClass}
                title="显示"
                aria-label="显示"
                onClick={() =>
                  void revealItemInDir(entry.path).catch((reason) =>
                    onError(`无法定位文件：${String(reason)}`),
                  )
                }
              >
                <FolderOpen size={13} strokeWidth={1.8} />
              </button>
            </span>
          </div>
          {entry.isDir &&
            open &&
            pathWithin(entry.path, projectPath, IS_WINDOWS) &&
            renderEntries(entry.path, depth + 1)}
        </li>
      );
    });
  }

  function renderFlat(files: { path: string; name: string; rel?: string }[]) {
    if (files.length === 0) {
      return <p className="px-2 py-3 text-xs text-l4">{query.trim() ? "没有匹配" : "没有这类文件"}</p>;
    }
    return (
      <ul className="space-y-0.5">
        {files.map((file) => (
          <li key={file.path}>
            <div
              className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 ${
                preview?.path === file.path ? "bg-hover" : "hover:bg-hover"
              }`}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-l2 outline-none focus:outline-none focus-visible:outline-none"
                data-file-path={file.path}
                onClick={() => openFile(asFileEntry(file))}
                title={file.path}
              >
                <FileTypeMark path={file.path} />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                {goalMarkFor(file.path) && (
                  <span className="shrink-0 text-micro text-warn-text">{pendingMark}</span>
                )}
                {file.rel && file.rel !== file.name && (
                  <span className="max-w-[40%] truncate font-mono text-micro text-l4">
                    {file.rel}
                  </span>
                )}
              </button>
              <span className="absolute inset-y-0 right-1 hidden items-center bg-hover pl-1 group-hover:flex group-focus-within:flex">
                <button
                  type="button"
                  className={iconActionClass}
                  title="问 AI"
                  aria-label="问 AI"
                  onClick={() => askAi(asFileEntry(file))}
                >
                  <MessageSquare size={13} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className={iconActionClass}
                  title="显示"
                  aria-label="显示"
                  onClick={() =>
                    void revealItemInDir(file.path).catch((reason) =>
                      onError(`无法定位文件：${String(reason)}`),
                    )
                  }
                >
                  <FolderOpen size={13} strokeWidth={1.8} />
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  const windowKind = preview ? projectFilePreviewKind(preview.path) : "text";
  const windowXl = windowKind === "xlsx" || windowKind === "pdf";

  function previewChrome() {
    if (!preview) return null;
    return (
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <FileTypeMark path={preview.path} />
        <span className="min-w-0 flex-1 truncate text-sm text-l1" title={preview.path}>
          {preview.name}
        </span>
        <button
          type="button"
          className={rowActionClass}
          onClick={() => stepPreview(-1)}
          disabled={!prevFile}
          title="上一个文件（↑）"
        >
          ↑
        </button>
        <button
          type="button"
          className={rowActionClass}
          onClick={() => stepPreview(1)}
          disabled={!nextFile}
          title="下一个文件（↓）"
        >
          ↓
        </button>
        <button
          type="button"
          className={`${rowActionClass} gap-1`}
          onClick={() => setWindowed(true)}
        >
          <Maximize2 size={12} aria-hidden="true" />
          窗口预览
        </button>
        <button
          type="button"
          className={ghostActionClass}
          onClick={() => {
            setPreview(null);
            setWindowed(false);
          }}
          aria-label="关闭预览"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-[calc(100dvh-9rem)] min-h-[20rem] overflow-hidden">
        <section
          className={`flex h-full min-h-0 shrink-0 flex-col ${
            preview ? "w-full lg:w-[22rem] lg:pr-6" : "w-full"
          } ${projectWellClass}`}
        >
          <div className="mb-2 flex shrink-0 flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <FileKindFilters
                filter={filter}
                counts={kindCounts}
                onChange={setFilter}
              />
              <button
                type="button"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l3 hover:bg-hover hover:text-l1"
                title="刷新"
                aria-label="刷新"
                onClick={() => void load(projectPath)}
              >
                <RefreshCw size={13} strokeWidth={1.8} />
              </button>
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索"
              className={`${searchFieldClass} w-full`}
              aria-label="搜索文件"
            />
          </div>
          <div
            ref={listRef}
            className="ccode-file-list min-h-0 flex-1 overflow-y-auto outline-none"
            aria-label="项目文件列表"
          >
            {loading ? (
              <p className="px-2 py-3 text-xs text-l4">读取文件…</p>
            ) : filtering ? (
              renderFlat(filteredFiles)
            ) : cache[projectPath]?.length ? (
              <ul className="space-y-0.5">{renderEntries(projectPath, 0)}</ul>
            ) : (
              <p className="px-2 py-3 text-xs text-l4">项目目录为空</p>
            )}
          </div>
        </section>
        {preview && (
          <section
            className={`ml-0 hidden h-full min-h-0 min-w-0 flex-1 flex-col lg:flex ${projectWellClass}`}
          >
            {previewChrome()}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none">
              <ProjectFilePreview
                key={preview.path}
                path={preview.path}
                root={projectPath}
                onOpenFile={openPath}
              />
            </div>
          </section>
        )}
      </div>
      {preview && !windowed && (
        <section className={`mt-4 lg:hidden ${projectWellClass}`}>
          {previewChrome()}
          <div className="flex h-[70vh] min-h-0 flex-col overflow-hidden overscroll-none">
            <ProjectFilePreview
              key={preview.path}
              path={preview.path}
              root={projectPath}
              onOpenFile={openPath}
            />
          </div>
        </section>
      )}
      {preview && windowed && (
        <Modal
          open
          title={preview.name}
          onClose={() => setWindowed(false)}
          overflow="hidden"
          size={windowXl ? "xl" : "lg"}
          panelClassName={
            windowXl
              ? "h-[min(88vh,920px)] max-w-[min(96vw,1280px)]"
              : "h-[80vh] max-w-4xl"
          }
          contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-none"
        >
          <div className="mb-2 flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={`${rowActionClass} ml-auto`}
              onClick={() => stepPreview(-1)}
              disabled={!prevFile}
              title="上一个文件（↑）"
            >
              ↑
            </button>
            <button
              type="button"
              className={rowActionClass}
              onClick={() => stepPreview(1)}
              disabled={!nextFile}
              title="下一个文件（↓）"
            >
              ↓
            </button>
          </div>
          <ProjectFilePreview
            key={preview.path}
            path={preview.path}
            root={projectPath}
            onOpenFile={openPath}
          />
        </Modal>
      )}
    </>
  );
}
