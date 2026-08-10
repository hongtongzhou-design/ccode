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
 * 左栏「项目」区：固定列出所有建有活跃工作区的仓库（每仓一个小节：主文件夹 + 活跃工作区列表），
 * 当前标签 cwd 命中的项目置顶并标注「当前」（无活跃工作区也保留，不消失）。
 * 点击名称 = 切根（复用 enterCwd「真进入」链路，文件树根与右侧面板随标签 cwd 联动）；
 * 箭头只展开该节点的一层目录（list_dir 只读，不点不拉）。已归档/未创建的工作区不列出。
 */

/** 一个小节 = 一个有活跃工作区的仓库（或 cwd 命中的当前项目） */
interface RailSection {
  repo: string;
  name: string;
  ws: WorkspaceDto[];
  current: boolean;
}
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
  /** 仓库根 →（工作区名 → 流水线步骤名），按小节分别读 project.toml（best-effort） */
  const [stepNames, setStepNames] = useState<Record<string, Record<string, string>>>({});
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

  // 小节列表：所有建有活跃工作区的仓库固定列出；当前项目（cwd 命中）置顶并标注，
  // 即使无活跃工作区也保留（用户在该目录但还没建工作区时不消失）；其余按名称排序
  const sections = useMemo<RailSection[]>(() => {
    const nameOf = (repo: string) =>
      projects.find((p) => pathWithin(p.path, repo) && pathWithin(repo, p.path))?.name ??
      basenameOf(repo);
    const sameRepo = (a: string, b: string) => pathWithin(a, b) && pathWithin(b, a);
    const byRepo = new Map<string, WorkspaceDto[]>();
    for (const w of active) {
      const list = byRepo.get(w.repoPath) ?? [];
      list.push(w);
      byRepo.set(w.repoPath, list);
    }
    const list: RailSection[] = [];
    for (const [repo, ws] of byRepo) {
      list.push({ repo, name: nameOf(repo), ws, current: !!root && sameRepo(repo, root) });
    }
    if (root && !list.some((s) => s.current)) {
      list.push({ repo: root, name: nameOf(root), ws: [], current: true });
    }
    list.sort((a, b) =>
      a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1,
    );
    return list;
  }, [active, projects, root]);

  // 步骤名映射：逐小节仓库读一次 project.toml（失败则只显示工作区名）
  useEffect(() => {
    let cancelled = false;
    for (const sec of sections) {
      invoke<ProjectConfigReadDto>("read_project_config", { path: sec.repo })
        .then((read) => {
          if (cancelled) return;
          const map: Record<string, string> = {};
          for (const s of read.config.steps) {
            if (s.workspaceName) map[s.workspaceName] = s.name;
          }
          setStepNames((prev) => ({ ...prev, [sec.repo]: map }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [sections]);

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
          <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
        ) : (
          <File aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-l4" />
        )}
        <span className="truncate text-l3">{e.name}</span>
      </div>
    ));
  }

  if (sections.length === 0) return null;

  /** 主文件夹节点（小节首行）：cwd 在主仓内且不在任何工作区工作树内时高亮（工作树在 repo/.ccode/workspaces 下，会双重命中） */
  function renderMainRow(sec: RailSection) {
    const mainActive =
      pathWithin(cwd, sec.repo) && !sec.ws.some((w) => pathWithin(cwd, w.worktreePath));
    return (
      <div>
        <div
          className={`flex items-center gap-1 py-0.5 pr-2 text-xs ${
            mainActive ? "bg-white/10" : ""
          }`}
          style={{ paddingLeft: 6 }}
        >
          <button
            onClick={() => toggleDir(sec.repo)}
            className="w-3 shrink-0 text-l4"
            title={expandedDirs.has(sec.repo) ? "收起" : "展开一层目录"}
          >
            {expandedDirs.has(sec.repo) ? "▾" : "▸"}
          </button>
          {expandedDirs.has(sec.repo) ? (
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          ) : (
            <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-folder" />
          )}
          <span
            onClick={() => enter(sec.repo)}
            title={`${sec.repo}\n点击切到主文件夹`}
            className="min-w-0 flex-1 cursor-pointer truncate font-medium text-l2 hover:text-l1"
          >
            {sec.name}
          </span>
          <span className="shrink-0 text-[10px] text-l4">主</span>
        </div>
        {renderDirRows(sec.repo, 0)}
      </div>
    );
  }

  /** 活跃工作区行（交互、悬浮信息、状态点与原实现一致） */
  function renderWsRow(sec: RailSection, w: WorkspaceDto) {
    const wsActive = pathWithin(cwd, w.worktreePath);
    const tab = tabs.find((t) => pathWithin(t.cwd, w.worktreePath));
    const dot =
      tab?.attention === "confirm"
        ? "bg-warn-text"
        : tab?.attention === "done"
          ? "bg-link"
          : tab?.attention === "working"
            ? "bg-ok-text animate-pulse-brief"
            : tab?.running
              ? "bg-ok-text"
              : null;
    const stepName = stepNames[sec.repo]?.[w.name];
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
              className={`size-2 shrink-0 rounded-full ${dot}`}
              title={
                tab?.attention === "confirm"
                  ? "待确认"
                  : tab?.attention === "done"
                    ? "已完成"
                    : "工作中"
              }
            />
          )}
        </div>
        {renderDirRows(w.worktreePath, 1)}
      </div>
    );
  }

  return (
    <div className="shrink-0">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 px-2 py-2 text-left text-[10px] text-l4 hover:text-l2"
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>项目</span>
      </button>
      {!collapsed && (
        <div className="max-h-56 overflow-auto pb-1">
          {sections.map((sec) => (
            <div key={sec.repo}>
              {/* 多小节时组头标仓库名；当前项目标注「当前」（单小节保持原样，不加噪音） */}
              {sections.length > 1 && (
                <p
                  className={`truncate px-2 pb-0.5 pt-1.5 text-[10px] ${sec.current ? "text-l2" : "text-l4"}`}
                  title={sec.repo}
                >
                  {sec.name}
                  {sec.current && " · 当前"}
                </p>
              )}
              {renderMainRow(sec)}
              {sec.ws.map((w) => renderWsRow(sec, w))}
              {sec.current && sec.ws.length === 0 && (
                <p className="py-0.5 text-[11px] text-l4" style={{ paddingLeft: 18 }}>
                  暂无活跃工作区
                </p>
              )}
            </div>
          ))}
          {hint && <p className="px-2 py-0.5 text-[11px] text-warn-text">{hint}</p>}
        </div>
      )}
    </div>
  );
}

export default memo(ProjectRail);
