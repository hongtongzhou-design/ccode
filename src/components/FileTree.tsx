import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { File, FolderClosed, FolderOpen } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { ghostActionClass, LoadingRows } from "./PageFrame";
import { useAppStore } from "../store";
import {
  hasChangedInside,
  normSep,
  normalizeStatusKeys,
  parentDir,
} from "../path-utils";

export interface SearchResultDto {
  path: string;
  name: string;
  isDir: boolean;
  /** 相对搜索根的路径（后端算好，直接展示） */
  rel: string;
}

export interface DirEntryDto {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string | null;
}

/** git 状态字母配色（M 改 / A·?? 增 / D 删 / R 改名） */
const STATUS_COLOR: Record<string, string> = {
  M: "text-warn-text",
  A: "text-ok-text",
  "??": "text-ok-text",
  D: "text-err-text",
  R: "text-l3",
};

/** git 状态字母的悬停白话说明（双层呈现：字母徽标供程序员扫读，悬浮给不懂 git 的用户） */
const STATUS_WORD: Record<string, string> = {
  M: "有未保存的改动",
  A: "新文件（待提交）",
  "??": "新文件",
  D: "已删除",
  R: "已重命名",
};

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function pathWithin(path: string, base: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === normalizedBase || normalizedPath.startsWith(`${normalizedBase}/`);
}

/** FileTreeNode 的下传上下文：父组件需保证这些回调/引用稳定，memo 才有效 */
interface TreeNodeCtx {
  root: string;
  expanded: Set<string>;
  cache: Record<string, DirEntryDto[]>;
  /** 键已 normalizeStatusKeys 归一（/ 分隔） */
  gitMap: Record<string, string>;
  highlight: string | null;
  load: (path: string) => Promise<void>;
  toggle: (path: string) => void;
  nav: (path: string) => Promise<boolean>;
  onOpenFile: (path: string, name: string, root: string) => void;
  onOpenTerminal: (path: string) => void;
  onMenu: (menu: { x: number; y: number; path: string; isDir: boolean }) => void;
}

/**
 * 树节点（模块级 + memo）：定义在 FileTree 外的稳定组件类型，
 * 父组件因搜索框输入等无关状态重渲染时不会整树 remount / 重渲染。
 */
const FileTreeNode = memo(function FileTreeNode({
  entry,
  depth,
  ctx,
}: {
  entry: DirEntryDto;
  depth: number;
  ctx: TreeNodeCtx;
}) {
  const { expanded, cache, gitMap, highlight, root, load, toggle, nav } = ctx;
  const isOpen = expanded.has(entry.path);
  const children = cache[entry.path];
  const gitStatus = entry.isDir ? undefined : gitMap[normSep(entry.path)];
  const dirtyDir = entry.isDir && hasChangedInside(gitMap, entry.path);
  // 展开才读取子目录（懒加载）
  useEffect(() => {
    if (entry.isDir && isOpen && !children) void load(entry.path);
  }, [isOpen, entry.isDir, entry.path, children, load]);
  return (
    <>
      <div
        onClick={() =>
          entry.isDir ? toggle(entry.path) : ctx.onOpenFile(entry.path, entry.name, root)
        }
        onDoubleClick={() => {
          if (entry.isDir) void nav(entry.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.onMenu({ x: e.clientX, y: e.clientY, path: entry.path, isDir: entry.isDir });
        }}
        title={entry.isDir ? `${entry.path}\n双击进入，右键在此打开终端` : entry.path}
        className={`group flex cursor-pointer items-center gap-1 py-0.5 pr-2 text-xs hover:bg-hover ${
          highlight === entry.path ? "bg-white/10" : ""
        }`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <span className="w-3 shrink-0 text-l4">
          {entry.isDir ? (isOpen ? "▾" : "▸") : ""}
        </span>
        {entry.isDir ? (
          isOpen ? (
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          ) : (
            <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          )
        ) : (
          <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
        )}
        <span className="truncate text-l3">{entry.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {gitStatus && (
            <span
              className={`font-mono text-micro opacity-75 ${STATUS_COLOR[gitStatus] ?? "text-l3"}`}
              title={STATUS_WORD[gitStatus] ?? gitStatus}
            >
              {gitStatus === "??" ? "?" : gitStatus}
            </span>
          )}
          {dirtyDir && (
            <span className="text-l4" title="里面有未保存的改动">
              ●
            </span>
          )}
          {entry.isDir && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                ctx.onOpenTerminal(entry.path);
              }}
              title="在此打开新终端"
              className="hidden shrink-0 text-l4 hover:text-l1 group-hover:block"
            >
              ↗
            </button>
          )}
        </span>
      </div>
      {entry.isDir && isOpen && !children && (
        <div
          className="py-1"
          style={{ paddingLeft: 6 + (depth + 1) * 12 }}
        >
          <span className="block h-1.5 w-16 animate-pulse rounded-sm bg-inset" />
        </div>
      )}
      {entry.isDir &&
        isOpen &&
        children?.map((c) => (
          <FileTreeNode key={c.path} entry={c} depth={depth + 1} ctx={ctx} />
        ))}
    </>
  );
});

/** 路径归属（workspaces::path_context）：根目录落在主仓库还是工作区分支 */
interface PathContext {
  kind: "worktree" | "main" | "other";
  workspaceName: string | null;
  branch: string | null;
  worktreePath: string | null;
  repoPath: string | null;
  /** 同仓库其他活跃工作区（主项目⇄多分支的切换列表） */
  siblings: { workspaceName: string; branch: string; worktreePath: string }[];
}

/**
 * 工作树（借鉴 VS Code Explorer 的懒加载）：外部锚点是活动终端标签的 cwd，
 * 用户可双击目录钻取重定根（manual root），切换标签时重置回该标签 cwd。
 * 单击目录 = 展开/收起；双击目录 = 进入（重定根）；右键 / 悬停按钮 = 在此打开新终端。
 */
function FileTree({
  cwd,
  showHidden,
  refreshKey,
  onOpenFile,
  onOpenTerminal,
  onFsEvent,
  onEnterProject,
  onRootChange,
  belowRecent,
}: {
  cwd: string;
  showHidden: boolean;
  refreshKey: number;
  onOpenFile: (path: string, name: string, root: string) => void;
  onOpenTerminal: (path: string) => void;
  /** 文件系统变化回调（fs-changed 防抖后触发，供 GitPanel 等联动刷新） */
  onFsEvent?: () => void;
  /** 最近项目「真进入」：切树根 + 切换活动标签启动栏 cwd */
  onEnterProject?: (path: string) => void;
  /** 根目录切换前通知；返回/resolve false 时保留当前根（用于保护未保存预览，确认框为异步）。 */
  onRootChange?: (path: string) => boolean | Promise<boolean>;
  /** 插在搜索行（含最近项目下拉）与完整树之间的自定义区块（如项目树） */
  belowRecent?: ReactNode;
}) {
  // manual root：默认锚定活动标签 cwd，钻取/上级由用户驱动
  const [root, setRoot] = useState(cwd);
  const rootRef = useRef(root);
  rootRef.current = root;
  const onRootChangeRef = useRef(onRootChange);
  onRootChangeRef.current = onRootChange;
  /** 所有主动跳转统一走 nav；未保存预览可阻止切换。走 ref 保持稳定身份（树节点 memo 依赖） */
  const nav = useCallback(async (path: string): Promise<boolean> => {
    if (path === rootRef.current) return true;
    if ((await onRootChangeRef.current?.(path)) === false) return false;
    setRoot(path);
    return true;
  }, []);
  /** 返回上一级目录（不受项目范围限制） */
  function goUp() {
    const p = parentDir(root);
    if (p) void nav(p);
  }
  const recentRepos = useAppStore((s) => s.recentRepos);
  const recentReposLoading = useAppStore((s) => s.recentReposLoading);
  const recentReposLoaded = useAppStore((s) => s.recentReposLoaded);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  // 最近项目：搜索框旁 ⌄ 下拉浮层（Esc / 点外部关闭）
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  useEffect(() => {
    if (!recentMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRecentMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recentMenuOpen]);

  // App 启动时已预取；终端首次挂载再兜底触发一次，store 会合并并发请求。
  useEffect(() => {
    void loadRecentRepos().catch(() => {});
  }, [loadRecentRepos]);
  const [cache, setCache] = useState<Record<string, DirEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [gitMap, setGitMap] = useState<Record<string, string>>({});
  // 当前根的路径归属（主仓库/工作区分支）；other 或查询失败不显示徽标
  const [ctx, setCtx] = useState<PathContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<PathContext>("path_context", { path: root })
      .then((c) => {
        if (!cancelled) setCtx(c.kind === "other" ? null : c);
      })
      .catch(() => {
        if (!cancelled) setCtx(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  /** 主项目 ⇄ 分支互切：重定树根 + 终端真进入（同最近项目语义） */
  function switchTo(path: string) {
    void nav(path).then((ok) => {
      if (ok) onEnterProject?.(path);
    });
  }
  // ⇄ 下拉：主项目 + 同仓库全部活跃工作区（多工作区时不再只能两点互切）
  const [switchMenu, setSwitchMenu] = useState<{ x: number; y: number } | null>(null);

  // 切换活动标签（cwd 变化）时重置回该标签的 cwd
  useEffect(() => {
    if (cwd === rootRef.current) return;
    void (async () => {
      if ((await onRootChangeRef.current?.(cwd)) === false) return;
      setRoot(cwd);
    })();
  }, [cwd]);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", { path, showHidden });
        setCache((prev) => ({ ...prev, [path]: entries }));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [showHidden],
  );

  // git 装饰：变更文件状态表（非仓库 → 空）
  // Windows 下后端键是混合分隔符的 join 路径，归一成 / 后与 entry.path 同口径匹配
  const loadGitMap = useCallback(async () => {
    try {
      setGitMap(
        normalizeStatusKeys(
          await invoke<Record<string, string>>("git_status_map", { cwd: root }),
        ),
      );
    } catch {
      setGitMap({});
    }
  }, [root]);
  useEffect(() => {
    void loadGitMap();
  }, [loadGitMap, refreshKey]);

  // 文件监听（P4）：根目录变化时重挂 watcher；fs-changed → 缓存失效 + git 装饰刷新
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    void (async () => {
      try {
        watchId = await invoke<string>("watch_dir", { path: root });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, () => {
          // 就地重载根与已展开目录（不清缓存，旧内容保持显示直到新数据到达，避免闪烁）
          for (const p of [root, ...expandedRef.current]) void load(p);
          void loadGitMap();
          onFsEvent?.();
        });
      } catch {
        // 监听失败（目录不可读等）退回手动刷新
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
  }, [root, load, loadGitMap, onFsEvent]);

  // 重定根 / 显隐切换：清空缓存与展开状态
  useEffect(() => {
    setCache({});
    setExpanded(new Set());
  }, [root, showHidden]);

  // 手动刷新：只清缓存，展开状态保留（展开的节点会自动重载）
  useEffect(() => {
    if (refreshKey > 0) setCache({});
  }, [refreshKey]);

  // 根目录缓存缺失时加载
  useEffect(() => {
    if (!cache[root]) void load(root);
  }, [cache, root, load]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const parent = parentDir(root);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultDto[] | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清掉高亮定时器，避免组件销毁后 setState
  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );
  const [newFolderFor, setNewFolderFor] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");

  async function submitNewFolder() {
    const parent = newFolderFor;
    const name = newFolderName.trim();
    setNewFolderFor(null);
    setNewFolderName("");
    if (!parent || !name) return;
    try {
      await invoke("fs_create_dir", { root: parent, name });
      for (const p of [root, ...expandedRef.current]) void load(p);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 搜索结果定位：跳到所在目录并高亮（不打开预览） */
  async function locate(r: SearchResultDto) {
    const target = r.isDir ? r.path : parentDir(r.path);
    if (target) {
      if (!(await nav(target))) return;
      setResults(null);
      setQuery("");
      setHighlight(r.path);
      setExpanded((prev) => new Set(prev).add(target));
      // 连续定位先清旧定时器，避免旧计时提前熄灭新高亮
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlight(null), 2000);
    }
  }

  // 搜索防抖：300ms 后在项目根内按文件名查找
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      invoke<SearchResultDto[]>("search_files", { root, query: q })
        .then(setResults)
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, root]);
  // 树节点上下文：useMemo 保持身份稳定，搜索输入等无关状态变化时令 memo 节点跳过重渲染
  const nodeCtx = useMemo<TreeNodeCtx>(
    () => ({
      root,
      expanded,
      cache,
      gitMap,
      highlight,
      load,
      toggle,
      nav,
      onOpenFile,
      onOpenTerminal,
      onMenu: setMenu,
    }),
    [root, expanded, cache, gitMap, highlight, load, toggle, nav, onOpenFile, onOpenTerminal],
  );

  const children = cache[root];
  // 当前项目已在下方文件树中，不在“最近”里重复；最多保留四个真正可切换的目标。
  const recent = recentRepos
    .filter((repo) => !pathWithin(root, repo.path))
    .slice(0, 4);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部：文件名搜索（无描边，底色分层）+ 最近项目 ⌄ 下拉浮层（浮层允许边框） */}
      <div className="relative shrink-0 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder={`搜索 ${basenameOf(root)}…`}
            className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1 text-xs text-l2 outline-none transition-colors placeholder:text-l4 focus:bg-raised"
          />
          {(recent.length > 0 || (!recentReposLoaded && recentReposLoading)) && (
            <button
              onClick={() => setRecentMenuOpen((v) => !v)}
              title="最近项目"
              aria-expanded={recentMenuOpen}
              className={`${ghostActionClass} shrink-0`}
            >
              ⌄
            </button>
          )}
        </div>
        {recentMenuOpen && (
          <>
            {/* 透明罩：点浮层外任意处关闭 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setRecentMenuOpen(false)}
            />
            <div className="absolute inset-x-2 top-full z-50 mt-0.5 max-h-56 overflow-auto rounded-md border border-field ccode-float-surface py-1">
              {!recentReposLoaded && recent.length === 0 ? (
                <div className="space-y-1 px-2 py-0.5" aria-label="正在加载最近项目">
                  {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="h-4 animate-pulse rounded-sm bg-inset" />
                  ))}
                </div>
              ) : (
                recent.map((r) => (
                  <div
                    key={r.path}
                    onClick={async () => {
                      try {
                        // 目录可能已归档/移动，先验证再切换，避免树卡进无效根
                        await invoke("list_dir", { path: r.path, showHidden: false });
                        if (!(await nav(r.path))) return;
                        onEnterProject?.(r.path);
                        setResults(null);
                        setQuery("");
                        setError(null);
                        setRecentMenuOpen(false);
                      } catch {
                        setError(`目录不存在或已移动：${r.path}`);
                      }
                    }}
                    title={`${r.path}${r.lastActive ? `\n最近活动：${new Date(r.lastActive).toLocaleString("zh-CN")}` : ""}\n点击进入；↗ 打开新终端`}
                    className="group cursor-pointer px-2 py-1 text-xs text-l2 hover:bg-hover hover:text-l1"
                  >
                    <span className="flex items-center gap-1">
                      <span className="shrink-0 text-l4">◔</span>
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenTerminal(r.path);
                          setRecentMenuOpen(false);
                        }}
                        title="在此打开新终端"
                        className="hidden shrink-0 text-l4 hover:text-l1 group-hover:block"
                      >
                        ↗
                      </button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
      {belowRecent}
      {/* 当前根：加粗 basename + 完整路径 tooltip；偏离锚点时给「回到当前项目」 */}
      <div
        className="flex items-center gap-1 px-2 py-1 text-xs font-semibold text-l1"
        title={root}
      >
        {parent && (
          <button
            onClick={goUp}
            title={`上一级：${parent}`}
            className="shrink-0 text-l4 hover:text-l1"
          >
            ←
          </button>
        )}
        <span className="truncate">{basenameOf(root)}</span>
        {ctx?.kind === "worktree" && (
          <span
            className="flex shrink-0 items-center gap-1 font-normal text-l3"
            title={`工作区「${ctx.workspaceName}」的工作树，改动属于分支 ${ctx.branch}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
            分支
          </span>
        )}
        {ctx?.kind === "main" && (
          <span
            className="flex shrink-0 items-center gap-1 font-normal text-warn-text"
            title={`主仓库（${ctx.branch}），这里的改动不属于任何工作区分支`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn-text" />
            主仓库
          </span>
        )}
        {((ctx?.kind === "worktree" && ctx.repoPath) ||
          (ctx?.kind === "main" && ctx.siblings.length > 0)) && (
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSwitchMenu({ x: r.left, y: r.bottom + 4 });
            }}
            title="切换主项目 / 分支工作树"
            className="shrink-0 text-l4 hover:text-l1"
          >
            ⇄
          </button>
        )}
        {root !== cwd && (
          <button
            onClick={() => void nav(cwd)}
            title="回到当前项目"
            className="ml-auto shrink-0 text-l4 hover:text-l1"
          >
            ⌂
          </button>
        )}
      </div>
      {newFolderFor && (
        <div className="flex items-center gap-1 px-2 py-1">
          <span className="shrink-0 text-xs text-l4">新建于 {basenameOf(newFolderFor)}:</span>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewFolder();
              if (e.key === "Escape") setNewFolderFor(null);
            }}
            onBlur={() => void submitNewFolder()}
            placeholder="文件夹名称"
            className="min-w-0 flex-1 rounded-sm border border-field bg-inset px-1.5 py-0.5 text-xs text-l2 outline-none"
          />
        </div>
      )}
      {error && <p className="px-2 py-1 text-xs text-err-text">{error}</p>}

      {results !== null ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {results.length === 0 ? (
            <p className="px-2 py-1 text-xs text-l4">无匹配文件</p>
          ) : (
            results.map((r) => (
              <div
                key={r.path}
                onClick={() => locate(r)}
                title={r.path}
                className="cursor-pointer truncate px-2 py-0.5 text-xs text-l2 hover:bg-hover"
              >
                {r.isDir ? (
                  <FolderClosed
                    aria-hidden="true"
                    className="mr-1 inline-block h-3.5 w-3.5 text-folder"
                  />
                ) : (
                  <File
                    aria-hidden="true"
                    className="mr-1 inline-block h-3.5 w-3.5 text-l4"
                  />
                )}
                {r.rel}
              </div>
            ))
          )}
        </div>
      ) : !children ? (
        <div className="px-2">
          <LoadingRows compact />
        </div>
      ) : children.length === 0 ? (
        <p className="px-2 py-1 text-xs text-l4">空目录</p>
      ) : (
        children.map((c) => <FileTreeNode key={c.path} entry={c} depth={0} ctx={nodeCtx} />)
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.isDir
              ? [
                  {
                    label: "在此打开新终端",
                    onSelect: () => onOpenTerminal(menu.path),
                  },
                  {
                    label: "新建文件夹",
                    onSelect: async () => {
                      setNewFolderFor(menu.path);
                    },
                  },
                ]
              : []),
            {
              label: menu.isDir ? "删除目录" : "删除文件",
              onSelect: async () => {
                if (
                  !(await confirmDialog(
                    `删除「${menu.path}」${menu.isDir ? "（含全部内容）" : ""}？将移入系统回收站。`,
                    { danger: true },
                  ))
                )
                  return;
                try {
                  await invoke("fs_delete_path", { path: menu.path, root });
                  for (const p of [root, ...expandedRef.current]) void load(p);
                } catch (e) {
                  setError(String(e));
                }
              },
            },
          ]}
        />
      )}

      {/* ⇄ 切换下拉：主项目 + 同仓库全部活跃工作区 */}
      {switchMenu && ctx && (
        <ContextMenu
          x={switchMenu.x}
          y={switchMenu.y}
          onClose={() => setSwitchMenu(null)}
          items={[
            ...(ctx.kind === "worktree" && ctx.repoPath
              ? [
                  {
                    label: `主项目（${basenameOf(ctx.repoPath)}）`,
                    onSelect: () => switchTo(ctx.repoPath!),
                  },
                ]
              : []),
            ...ctx.siblings.map((s) => ({
              label: `分支「${s.workspaceName}」`,
              onSelect: () => switchTo(s.worktreePath),
            })),
          ]}
        />
      )}
    </div>
  );
}

/** memo：父级重渲染（启动栏状态变化等）不级联到文件树 */
export default memo(FileTree);
