/**
 * 工作台「继续当前工作」主卡纯逻辑：选哪条当前工作、状态怎么说、继续跳哪。
 * 与 DOM/Tauri 解耦，供 node --test 直接测。
 */
import { pathKey, pathWithin, samePath } from "./path-utils.ts";
import { cwdBasename, buildRunOverview, type RunOverviewInput } from "./run-overview.ts";

export type WorkbenchHeroSource =
  | "running"
  | "context"
  | "recent-registered"
  | "recent";

export interface WorkbenchProject {
  path: string;
  name: string;
}

export interface WorkbenchRepo {
  path: string;
  name: string;
}

export interface WorkbenchWorkspaceRef {
  repoPath: string;
  worktreePath: string;
  name: string;
  status: string;
  mergedAt: string | null;
}

export interface WorkbenchHero {
  name: string;
  path: string;
  registered: boolean;
  /** 属于这张卡的运行标签（有则「继续工作」聚焦它） */
  tabId: string | null;
  agentId: string | null;
  model: string | null;
  attention: "confirm" | "working" | "done" | null;
  /** 这张卡所属项目/目录上的存活工作数（不是全应用） */
  runningCount: number;
  source: WorkbenchHeroSource;
}

export type WorkbenchContinue =
  | { kind: "terminal"; tabId: string }
  | { kind: "project"; path: string }
  | { kind: "enter-cwd"; path: string };

interface PathGroup {
  key: string;
  roots: string[];
  registered: boolean;
}

function isLiveWork(run: RunOverviewInput): boolean {
  return run.running || run.attention === "confirm";
}

function attributePath(
  cwd: string,
  groups: readonly PathGroup[],
  isWindows: boolean,
): string | null {
  let best: { key: string; len: number } | null = null;
  for (const g of groups) {
    for (const root of g.roots) {
      if (!pathWithin(cwd, root, isWindows)) continue;
      const len = pathKey(root, isWindows).length;
      if (!best || len > best.len) best = { key: g.key, len };
    }
  }
  return best?.key ?? null;
}

function nameForPath(
  path: string,
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  isWindows: boolean,
): string {
  const project = projects.find((p) => samePath(p.path, path, isWindows));
  const projectName = project?.name.trim();
  if (projectName) return projectName;
  const repo = recentRepos.find((r) => samePath(r.path, path, isWindows));
  const repoName = repo?.name.trim();
  if (repoName) return repoName;
  return cwdBasename(path) || path;
}

function buildGroups(
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  workspaces: readonly WorkbenchWorkspaceRef[],
  isWindows: boolean,
): PathGroup[] {
  const groups: PathGroup[] = [];
  for (const project of projects) {
    const trees = workspaces
      .filter(
        (w) =>
          w.status !== "archived" &&
          samePath(w.repoPath, project.path, isWindows),
      )
      .map((w) => w.worktreePath);
    groups.push({
      key: project.path,
      roots: [project.path, ...trees],
      registered: true,
    });
  }
  for (const repo of recentRepos) {
    if (groups.some((g) => samePath(g.key, repo.path, isWindows))) continue;
    groups.push({ key: repo.path, roots: [repo.path], registered: false });
  }
  return groups;
}

function heroAt(
  path: string,
  source: WorkbenchHeroSource,
  projects: readonly WorkbenchProject[],
  recentRepos: readonly WorkbenchRepo[],
  isWindows: boolean,
  live?: {
    tabId: string;
    agentId: string;
    model: string;
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
  },
): WorkbenchHero {
  const registered = projects.some((p) => samePath(p.path, path, isWindows));
  return {
    name: nameForPath(path, projects, recentRepos, isWindows),
    path,
    registered,
    tabId: live?.tabId ?? null,
    agentId: live?.agentId || null,
    model: live?.model || null,
    attention: live?.attention ?? null,
    runningCount: live?.runningCount ?? 0,
    source,
  };
}

export function pickWorkbenchHero(input: {
  projects: readonly WorkbenchProject[];
  recentRepos: readonly WorkbenchRepo[];
  workspaces: readonly WorkbenchWorkspaceRef[];
  runs: readonly RunOverviewInput[];
  contextName: string | null;
  isWindows?: boolean;
}): WorkbenchHero | null {
  const isWindows = input.isWindows ?? false;
  const groups = buildGroups(
    input.projects,
    input.recentRepos,
    input.workspaces,
    isWindows,
  );
  const live = buildRunOverview([...input.runs]).items.filter(isLiveWork);

  if (live.length > 0) {
    const top = live[0]!;
    const key = attributePath(top.cwd, groups, isWindows);
    const path = key ?? top.cwd;
    const mine = live.filter((run) => {
      const attributed = attributePath(run.cwd, groups, isWindows);
      if (key) return attributed === key;
      return (
        pathWithin(run.cwd, path, isWindows) ||
        pathWithin(path, run.cwd, isWindows)
      );
    });
    return heroAt(
      path,
      "running",
      input.projects,
      input.recentRepos,
      isWindows,
      {
        tabId: top.tabId,
        agentId: top.agentId,
        model: top.model,
        attention: top.attention,
        runningCount: mine.length,
      },
    );
  }

  const contextName = input.contextName?.trim() ?? "";
  if (contextName) {
    const byProjectName = input.projects.find((p) => p.name === contextName);
    if (byProjectName) {
      return heroAt(
        byProjectName.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
    const byRepoName = input.recentRepos.find((r) => r.name === contextName);
    if (byRepoName) {
      const registered = input.projects.find((p) =>
        samePath(p.path, byRepoName.path, isWindows),
      );
      return heroAt(
        registered?.path ?? byRepoName.path,
        "context",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
  }

  for (const repo of input.recentRepos) {
    const project = input.projects.find((p) =>
      samePath(p.path, repo.path, isWindows),
    );
    if (project) {
      return heroAt(
        project.path,
        "recent-registered",
        input.projects,
        input.recentRepos,
        isWindows,
      );
    }
  }
  if (input.recentRepos[0]) {
    return heroAt(
      input.recentRepos[0].path,
      "recent",
      input.projects,
      input.recentRepos,
      isWindows,
    );
  }
  return null;
}

export function continueWorkbenchTarget(hero: WorkbenchHero): WorkbenchContinue {
  if (hero.tabId) return { kind: "terminal", tabId: hero.tabId };
  if (hero.registered) return { kind: "project", path: hero.path };
  return { kind: "enter-cwd", path: hero.path };
}

/** 流水线里第一个尚未合并的步骤名；全做完回末步；没有步骤返回 null */
export function firstOpenStepName(
  steps: readonly { name: string; workspaceName: string }[],
  workspaces: readonly Pick<
    WorkbenchWorkspaceRef,
    "name" | "status" | "mergedAt"
  >[],
): string | null {
  if (steps.length === 0) return null;
  for (const step of steps) {
    const ws = workspaces.find(
      (w) => w.name === step.workspaceName && w.status !== "archived",
    );
    const done = Boolean(ws && ws.status === "active" && ws.mergedAt);
    if (!done) return step.name;
  }
  return steps[steps.length - 1]!.name;
}

export function heroStatusLine(opts: {
  runningCount: number;
  agentLabel: string | null;
  attention: "confirm" | "working" | "done" | null;
  registered: boolean;
}): string {
  if (opts.runningCount > 0) {
    const who = opts.agentLabel?.trim() || "Agent";
    if (opts.attention === "confirm") return `${who} 在等你确认`;
    return `${who} 正在工作`;
  }
  return opts.registered ? "准备好从上次位置继续" : "可从最近位置继续";
}

/** 有实质标题才返回；空标题（界面上的「未命名对话」）返回 null，工作台不列 */
export function namedSessionTitle(session: {
  customTitle: string | null;
  title: string | null;
}): string | null {
  const text = session.customTitle?.trim() || session.title?.trim() || "";
  return text || null;
}
