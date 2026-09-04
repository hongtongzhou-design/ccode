/**
 * 运行页左栏「项目」区纯逻辑。
 * 列出：科研活跃工作区所在仓 ∪ 正在跑/等确认的已添加项目 ∪ 当前标签所属项目。
 * 不铺编程工作树或办公文档；文件树仍只跟当前标签一棵。
 */
import { pathKey, pathWithin, samePath } from "./path-utils.ts";
import { normalizeWorkMode, type WorkMode } from "./work-mode.ts";

export interface RailTabSummary {
  cwd: string;
  running: boolean;
  attention: "done" | "working" | "confirm" | null;
}

export interface RailProject {
  path: string;
  name: string;
  workMode?: string | null;
}

export interface RailWorkspace {
  id: string;
  name: string;
  repoPath: string;
  worktreePath: string;
  status: string;
  branch?: string;
}

export interface RailCodingTree {
  repoPath: string;
  path: string;
}

export type RailMainLive = "confirm" | "working" | "running" | null;

export interface ProjectRailSection {
  repo: string;
  name: string;
  workMode: WorkMode | null;
  current: boolean;
  /** 科研活跃工作区；编程/办公为空 */
  ws: RailWorkspace[];
  /** 主文件夹行上的活标签点：cwd 不在任何科研工作树里时才打在「主」上 */
  mainLive: RailMainLive;
}

export function railTabIsLive(tab: {
  running: boolean;
  attention: "done" | "working" | "confirm" | null;
}): boolean {
  return tab.running || tab.attention === "confirm";
}

function liveKind(tab: RailTabSummary): Exclude<RailMainLive, null> | null {
  if (tab.attention === "confirm") return "confirm";
  if (tab.attention === "working") return "working";
  if (tab.running) return "running";
  return null;
}

function strongerLive(a: RailMainLive, b: RailMainLive): RailMainLive {
  const rank = { confirm: 3, working: 2, running: 1 };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** cwd 归到哪一个仓库根：科研工作树 / 编程工作树 / 已添加项目根，最长前缀胜。 */
export function attributeRailCwd(
  cwd: string,
  input: {
    projects: readonly RailProject[];
    workspaces: readonly RailWorkspace[];
    codingTrees: readonly RailCodingTree[];
    isWindows?: boolean;
  },
): string | null {
  if (!cwd.trim()) return null;
  const isWindows = input.isWindows ?? false;
  const best = { repo: null as string | null, len: -1 };
  const consider = (root: string, repo: string) => {
    if (!pathWithin(cwd, root, isWindows)) return;
    const len = pathKey(root, isWindows).length;
    if (len > best.len) {
      best.repo = repo;
      best.len = len;
    }
  };
  for (const w of input.workspaces) {
    if (w.status !== "active") continue;
    consider(w.worktreePath, w.repoPath);
    consider(w.repoPath, w.repoPath);
  }
  for (const t of input.codingTrees) {
    consider(t.path, t.repoPath);
    consider(t.repoPath, t.repoPath);
  }
  for (const p of input.projects) {
    consider(p.path, p.path);
  }
  return best.repo;
}

function isRegistered(
  repo: string,
  projects: readonly RailProject[],
  isWindows: boolean,
): boolean {
  return projects.some((p) => samePath(p.path, repo, isWindows));
}

/**
 * 运行页项目区小节。当前项置顶，其余按名称。
 * 科研活跃工作区即使没有活标签也列出；活标签只收已添加项目。
 */
export function buildProjectRailSections(input: {
  cwd: string;
  projects: readonly RailProject[];
  workspaces: readonly RailWorkspace[];
  codingTrees?: readonly RailCodingTree[];
  tabs: readonly RailTabSummary[];
  isWindows?: boolean;
}): ProjectRailSection[] {
  const isWindows = input.isWindows ?? false;
  const codingTrees = input.codingTrees ?? [];
  const attrInput = {
    projects: input.projects,
    workspaces: input.workspaces,
    codingTrees,
    isWindows,
  };
  const active = input.workspaces.filter((w) => w.status === "active");
  const byRepo = new Map<string, RailWorkspace[]>();
  const addRepo = (repo: string) => {
    const key =
      [...byRepo.keys()].find((k) => samePath(k, repo, isWindows)) ?? repo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    return key;
  };

  for (const w of active) {
    const key = addRepo(w.repoPath);
    byRepo.get(key)!.push(w);
  }

  for (const tab of input.tabs) {
    if (!railTabIsLive(tab)) continue;
    const repo = attributeRailCwd(tab.cwd, attrInput);
    if (!repo || !isRegistered(repo, input.projects, isWindows)) continue;
    addRepo(repo);
  }

  const current = attributeRailCwd(input.cwd, attrInput);
  if (current) addRepo(current);

  const nameOf = (repo: string) => {
    const p = input.projects.find((x) => samePath(x.path, repo, isWindows));
    return p?.name.trim() || basenameOf(repo);
  };
  const modeOf = (repo: string): WorkMode | null => {
    const p = input.projects.find((x) => samePath(x.path, repo, isWindows));
    return p ? normalizeWorkMode(p.workMode) : null;
  };

  const sections: ProjectRailSection[] = [];
  for (const [repo, ws] of byRepo) {
    let mainLive: RailMainLive = null;
    for (const tab of input.tabs) {
      if (!railTabIsLive(tab)) continue;
      const attributed = attributeRailCwd(tab.cwd, attrInput);
      if (!attributed || !samePath(attributed, repo, isWindows)) continue;
      const inWs = ws.some((w) =>
        pathWithin(tab.cwd, w.worktreePath, isWindows),
      );
      if (inWs) continue;
      mainLive = strongerLive(mainLive, liveKind(tab));
    }
    sections.push({
      repo,
      name: nameOf(repo),
      workMode: modeOf(repo),
      current: !!current && samePath(repo, current, isWindows),
      ws,
      mainLive,
    });
  }

  sections.sort((a, b) =>
    a.current === b.current
      ? a.name.localeCompare(b.name, "zh")
      : a.current
        ? -1
        : 1,
  );
  return sections;
}
