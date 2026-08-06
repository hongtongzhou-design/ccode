import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { File, FolderClosed, FolderOpen } from "lucide-react";
import type { DirEntryDto } from "./FileTree";
import type {
  ProjectConfigReadDto,
  ProjectDto,
  WorkspaceDto,
} from "../types";

/** 标签状态摘要：工作区注意力点的数据源，复用 TerminalPage 的 statuses 上报，不新增轮询通道 */
export interface RailTabSummary {
  cwd: string;
  running: boolean;
  attention: "done" | "working" | "confirm" | null;
}

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 归一化后判断 path 是否落在 base 内（含相等），与 FileTree 的口径一致 */
function pathWithin(path: string, base: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === b || p.startsWith(`${b}/`);
}

/**
 * 左栏「项目」区：当前标签 cwd 所属项目的主文件夹 + 其活跃工作区列表。
 * 点击名称 = 切根（复用 enterCwd「真进入」链路，文件树根与右侧面板随标签 cwd 联动）；
 * 箭头只展开该节点的一层目录（list_dir 只读，不点不拉）。已归档/未创建的工作区不列出。
 */
function ProjectRail({
  cwd,
  pageVisible,
  refreshKey,
  agentRunning,
  tabs,
  onEnter,
}: {
  /** 活动标签 cwd（项目归属与高亮判定的锚点） */
  cwd: string;
  /** 终端页可见性：从别页回来时重新拉取工作区列表 */
  pageVisible: boolean;
  /** 左栏 ⟳ 刷新键（与文件树共用） */
  refreshKey: number;
  /** 活动标签 agent 运行中：切根不落地（既有语义），只提示不打断 */
  agentRunning: boolean;
  /** 全部终端标签的状态摘要（工作区行的注意力点） */
  tabs: RailTabSummary[];
  /** 复用 enterCwd「真进入」链路 */
  onEnter: (path: string) => void;
}) {
  // 项目区整体折叠：默认展开
  const [collapsed, setCollapsed] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  /** 工作区名 → 流水线步骤名（读当前项目 project.toml，best-effort） */
  const [stepNames, setStepNames] = useState<Record<string, string>>({});
  /** 节点一层目录展开状态与缓存（组件内记忆即可） */
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirCache, setDirCache] = useState<Record<string, DirEntryDto[]>>({});
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // 工作区列表：进入终端页拉一次；⟳、回到本页、工作区归档事件时刷新
  const reload = useCallback(() => {
    invoke<WorkspaceDto[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(() => {});
    invoke<ProjectDto[]>("list_projects")
      .then(setProjects)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
  }, [reload, refreshKey, pageVisible]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("ws-archived", () => reload()).then((u) => (un = u));
    return () => un?.();
  }, [reload]);

  // 活跃工作区（未创建/已归档不列出）
  const active = useMemo(
    () => workspaces.filter((w) => w.status === "active"),
    [workspaces],
  );

  // 当前项目主文件夹：cwd 落在某活跃工作区的工作树 → 其 repo；落在某 repo/注册项目内 → 该根
  const root = useMemo(() => {
    for (const w of active) {
      if (pathWithin(cwd, w.worktreePath)) return w.repoPath;
    }
    for (const w of active) {
      if (pathWithin(cwd, w.repoPath)) return w.repoPath;
    }
    for (const p of projects) {
      if (pathWithin(cwd, p.path)) return p.path;
    }
    return null;
  }, [cwd, active, projects]);

  /** 当前项目的活跃工作区（repoPath 与主文件夹同根） */
  const children = useMemo(
    () =>
      root
        ? active.filter(
            (w) => pathWithin(w.repoPath, root) && pathWithin(root, w.repoPath),
          )
        : [],
    [root, active],
  );

  // 步骤名映射：当前项目换根时读一次 project.toml（失败则只显示工作区名）
  useEffect(() => {
    setStepNames({});
    if (!root) return;
    let cancelled = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: root })
      .then((read) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const s of read.config.steps) {
          if (s.workspaceName) map[s.workspaceName] = s.name;
        }
        setStepNames(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root]);

  /** 名称点击 = 切根；agent 运行中 cwd 不落地（既有语义），提示但不打断 */
  function enter(path: string) {
    if (agentRunning) {
      setHint("agent 运行中，本标签目录暂不切换");
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setHint(null), 3000);
      return;
    }
    onEnter(path);
  }

  /** 箭头：只展开/收起该节点的一层目录（list_dir 只读拉取，不点不拉） */
  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!dirCache[path]) {
      invoke<DirEntryDto[]>("list_dir", { path, showHidden: false })
        .then((entries) => setDirCache((prev) => ({ ...prev, [path]: entries })))
        .catch(() => {});
    }
  }

  /** 一层目录条目（只读展示；子目录可点击切根） */
  function renderDirRows(path: string, depth: number) {
    if (!expandedDirs.has(path)) return null;
    const entries = dirCache[path];
    if (!entries) {
      return (
        <div className="py-1" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>
          <span className="block h-1.5 w-16 animate-pulse rounded bg-inset" />
        </div>
      );
    }
    if (entries.length === 0) {
      return (
        <p
          className="py-0.5 text-[11px] text-l4"
          style={{ paddingLeft: 6 + (depth + 1) * 12 }}
        >
          空目录
        </p>
      );
    }
    return entries.map((e) => (
      <div
        key={e.path}
        onClick={e.isDir ? () => enter(e.path) : undefined}
        title={e.path}
        className={`flex items-center gap-1 py-0.5 pr-2 text-xs ${
          e.isDir ? "cursor-pointer hover:bg-white/5" : ""
        }`}
        style={{ paddingLeft: 6 + (depth + 1) * 12 }}
      >
        {e.isDir ? (
          <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
        ) : (
          <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
        )}
        <span className="truncate text-l3">{e.name}</span>
      </div>
    ));
  }

  if (!root) return null;
  const rootName = projects.find((p) => pathWithin(p.path, root) && pathWithin(root, p.path))?.name ?? basenameOf(root);
  // 主文件夹高亮：cwd 在主仓内且不在任何工作区工作树内（工作树在 repo/.ccode/workspaces 下，会双重命中）
  const mainActive =
    pathWithin(cwd, root) && !children.some((w) => pathWithin(cwd, w.worktreePath));

  return (
    <div className="shrink-0 border-b border-hairline">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] text-l4 hover:text-l2"
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>项目</span>
      </button>
      {!collapsed && (
        <div className="max-h-56 overflow-auto pb-1">
          {/* 主文件夹节点 */}
          <div
            className={`flex items-center gap-1 py-0.5 pr-2 text-xs ${
              mainActive ? "bg-white/10" : ""
            }`}
            style={{ paddingLeft: 6 }}
          >
            <button
              onClick={() => toggleDir(root)}
              className="w-3 shrink-0 text-l4"
              title={expandedDirs.has(root) ? "收起" : "展开一层目录"}
            >
              {expandedDirs.has(root) ? "▾" : "▸"}
            </button>
            {expandedDirs.has(root) ? (
              <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
            ) : (
              <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
            )}
            <span
              onClick={() => enter(root)}
              title={`${root}\n点击切到主文件夹`}
              className="min-w-0 flex-1 cursor-pointer truncate font-medium text-l2 hover:text-l1"
            >
              {rootName}
            </span>
            <span className="shrink-0 text-[10px] text-l4">主</span>
          </div>
          {renderDirRows(root, 0)}
          {/* 活跃工作区子节点 */}
          {children.map((w) => {
            const wsActive = pathWithin(cwd, w.worktreePath);
            const tab = tabs.find((t) => pathWithin(t.cwd, w.worktreePath));
            const dot =
              tab?.attention === "confirm"
                ? "text-warn-text"
                : tab?.attention === "done"
                  ? "text-link"
                  : tab?.attention === "working"
                    ? "text-ok-text animate-pulse"
                    : tab?.running
                      ? "text-ok-text"
                      : null;
            const stepName = stepNames[w.name];
            return (
              <div key={w.id}>
                <div
                  className={`flex items-center gap-1 py-0.5 pr-2 text-xs ${
                    wsActive ? "bg-white/10" : ""
                  }`}
                  style={{ paddingLeft: 18 }}
                >
                  <button
                    onClick={() => toggleDir(w.worktreePath)}
                    className="w-3 shrink-0 text-l4"
                    title={expandedDirs.has(w.worktreePath) ? "收起" : "展开一层目录"}
                  >
                    {expandedDirs.has(w.worktreePath) ? "▾" : "▸"}
                  </button>
                  <span
                    onClick={() => enter(w.worktreePath)}
                    title={`${w.worktreePath}\n分支 ${w.branch}，点击切到该工作区`}
                    className="min-w-0 flex-1 cursor-pointer truncate text-l2 hover:text-l1"
                  >
                    {w.name}
                    {stepName && (
                      <span className="text-l4"> · {stepName}</span>
                    )}
                  </span>
                  {dot && (
                    <span
                      className={`shrink-0 text-[10px] ${dot}`}
                      title={
                        tab?.attention === "confirm"
                          ? "待确认"
                          : tab?.attention === "done"
                            ? "已完成"
                            : "工作中"
                      }
                    >
                      ●
                    </span>
                  )}
                </div>
                {renderDirRows(w.worktreePath, 1)}
              </div>
            );
          })}
          {children.length === 0 && (
            <p className="py-0.5 text-[11px] text-l4" style={{ paddingLeft: 18 }}>
              暂无活跃工作区
            </p>
          )}
          {hint && <p className="px-2 py-0.5 text-[11px] text-warn-text">{hint}</p>}
        </div>
      )}
    </div>
  );
}

export default memo(ProjectRail);
