/**
 * 工作台「继续当前工作」主卡纯逻辑：选哪条当前工作、状态怎么说、继续跳哪。
 * 与 DOM/Tauri 解耦，供 node --test 直接测。
 */
import { pathKey, pathWithin, samePath } from "./path-utils.ts";
import { cwdBasename, buildRunOverview, type RunOverviewInput } from "./run-overview.ts";
import { isWorkbenchSurfaceRun } from "./run-model.ts";

export type WorkbenchHeroSource =
  | "running"
  | "context"
  | "recent-registered"
  | "recent";

export interface WorkbenchProject {
  path: string;
  name: string;
  workMode?: "research" | "coding" | "office" | null;
  lastOpenedAt?: string | null;
  createdAt?: string | null;
}

export interface WorkbenchRepo {
  path: string;
  name: string;
  lastActive?: string | null;
}

export interface WorkbenchRecentRow {
  path: string;
  name: string;
  lastActive: string | null;
  registered: boolean;
}

export interface WorkbenchWorkspaceRef {
  repoPath: string;
  worktreePath: string;
  name: string;
  status: string;
  mergedAt: string | null;
}

/** 一张工作台卡上的一次活着的干活（终端标签视图）。 */
export interface WorkbenchRunChip {
  tabId: string;
  agentId: string;
  attention: "confirm" | "working" | "done" | null;
  /** 工作区名 / 分支 / 文档名，不是 CLI 名 */
  taskLabel: string;
}

export interface WorkbenchHero {
  name: string;
  path: string;
  registered: boolean;
  /** 属于这张卡的运行标签（有则「继续工作」聚焦它）= runs 里优先级最高的一条 */
  tabId: string | null;
  agentId: string | null;
  model: string | null;
  attention: "confirm" | "working" | "done" | null;
  /** 这张卡所属项目/目录上的存活工作数（不是全应用） */
  runningCount: number;
  /** 同一项目上的多次 Run（待确认在前）；单次时状态行已够，UI 可不重复列 */
  runs: WorkbenchRunChip[];
  source: WorkbenchHeroSource;
  workMode?: "research" | "coding" | "office" | null;
  subtitle?: string | null;
}

export type WorkbenchContinue =
  | { kind: "terminal"; tabId: string }
  | { kind: "project"; path: string }
  | { kind: "enter-cwd"; path: string };

export interface WorkbenchNowSeed {
  path: string;
  name: string;
  registered: boolean;
  workMode: "research" | "coding" | "office" | null;
  subtitle: string | null;
  needsYou: boolean;
  extraRoots?: string[];
}

export interface WorkbenchNowItem extends WorkbenchHero {
  workMode: "research" | "coding" | "office" | null;
  subtitle: string | null;
  rank: number;
}

interface PathGroup {
  key: string;
  roots: string[];
  registered: boolean;
}

function isLiveWork(run: RunOverviewInput): boolean {
  return isWorkbenchSurfaceRun(run);
}

/** 标签标题优先；占位「终端」回落到目录尾段。 */
export function taskLabelForRun(run: {
  title: string;
  cwd: string;
}): string {
  const title = run.title.trim();
  if (title && title !== "终端") return title;
  return cwdBasename(run.cwd) || "这项工作";
}

function toRunChip(run: RunOverviewInput): WorkbenchRunChip {
  return {
    tabId: run.tabId,
    agentId: run.agentId,
    attention: run.attention,
    taskLabel: taskLabelForRun(run),
  };
}

function runChipRank(chip: WorkbenchRunChip): number {
  if (chip.attention === "confirm") return 0;
  if (chip.attention === "working") return 1;
  return 2;
}

function sortRunChips(runs: WorkbenchRunChip[]): WorkbenchRunChip[] {
  return [...runs].sort((a, b) => runChipRank(a) - runChipRank(b));
}

function pointerFromRuns(runs: readonly WorkbenchRunChip[]): {
  tabId: string | null;
  agentId: string | null;
  attention: "confirm" | "working" | "done" | null;
} {
  const top = runs[0];
  if (!top) return { tabId: null, agentId: null, attention: null };
  return {
    tabId: top.tabId,
    agentId: top.agentId || null,
    attention: top.attention,
  };
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

/** 工作台「最近项目 / 最近对话」最多条数。 */
export const WORKBENCH_RECENT_LIMIT = 10;

function laterIso(a?: string | null, b?: string | null): string | null {
  const left = a?.trim() || "";
  const right = b?.trim() || "";
  if (!left) return right || null;
  if (!right) return left;
  const lt = Date.parse(left);
  const rt = Date.parse(right);
  if (!Number.isNaN(lt) && !Number.isNaN(rt)) return lt >= rt ? left : right;
  return left >= right ? left : right;
}

function compareRecent(a: string | null, b: string | null): number {
  const left = a ?? "";
  const right = b ?? "";
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const lt = Date.parse(left);
  const rt = Date.parse(right);
  if (!Number.isNaN(lt) && !Number.isNaN(rt) && lt !== rt) return rt - lt;
  return right < left ? -1 : right > left ? 1 : 0;
}

/**
 * 工作台「最近项目」行：已添加项目 ∪ 会话扫出的仓库。
 * 办公/新建项目没有 Agent 会话、甚至不是 git，也必须出现。
 * 已添加用注册名；未添加（外部 Codex 等）标出来。按最近活动降序，默认最多 10 条。
 * 正在进行的主卡项目仍列入：刚添加的办公项目否则会从「最近」里消失。
 */
export function workbenchRecentRows(input: {
  recentRepos: readonly WorkbenchRepo[];
  projects: readonly WorkbenchProject[];
  excludePaths?: readonly string[];
  isWindows?: boolean;
  limit?: number;
}): WorkbenchRecentRow[] {
  const isWindows = input.isWindows ?? false;
  const limit = input.limit ?? WORKBENCH_RECENT_LIMIT;
  const exclude = input.excludePaths ?? [];
  const skipped = (path: string) =>
    exclude.some((p) => samePath(p, path, isWindows));
  const rows: WorkbenchRecentRow[] = [];

  for (const project of input.projects) {
    if (skipped(project.path)) continue;
    const repo = input.recentRepos.find((r) =>
      samePath(r.path, project.path, isWindows),
    );
    const name =
      project.name.trim() ||
      repo?.name.trim() ||
      cwdBasename(project.path) ||
      project.path;
    rows.push({
      path: project.path,
      name,
      lastActive: laterIso(
        laterIso(project.lastOpenedAt, project.createdAt),
        repo?.lastActive,
      ),
      registered: true,
    });
  }

  for (const repo of input.recentRepos) {
    if (skipped(repo.path)) continue;
    if (rows.some((row) => samePath(row.path, repo.path, isWindows))) continue;
    rows.push({
      path: repo.path,
      name: repo.name.trim() || cwdBasename(repo.path) || repo.path,
      lastActive: repo.lastActive ?? null,
      registered: false,
    });
  }

  rows.sort((a, b) => {
    const byTime = compareRecent(a.lastActive, b.lastActive);
    if (byTime !== 0) return byTime;
    return a.name.localeCompare(b.name, "zh");
  });
  return rows.slice(0, Math.max(0, limit));
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
    runs: WorkbenchRunChip[];
  },
): WorkbenchHero {
  const registered = projects.some((p) => samePath(p.path, path, isWindows));
  const workMode =
    projects.find((p) => samePath(p.path, path, isWindows))?.workMode ?? null;
  const runs = live?.runs ?? [];
  return {
    name: nameForPath(path, projects, recentRepos, isWindows),
    path,
    registered,
    tabId: live?.tabId ?? null,
    agentId: live?.agentId || null,
    model: live?.model || null,
    attention: live?.attention ?? null,
    runningCount: live?.runningCount ?? 0,
    runs,
    source,
    workMode,
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
    const runs = sortRunChips(mine.map(toRunChip));
    const pointer = pointerFromRuns(runs);
    const pointed = mine.find((run) => run.tabId === pointer.tabId) ?? top;
    return heroAt(
      path,
      "running",
      input.projects,
      input.recentRepos,
      isWindows,
      {
        tabId: pointer.tabId ?? pointed.tabId,
        agentId: pointer.agentId ?? pointed.agentId,
        model: pointed.model,
        attention: pointer.attention ?? pointed.attention,
        runningCount: runs.length,
        runs,
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

function nowRank(opts: {
  attention: "confirm" | "working" | "done" | null;
  runningCount: number;
  needsYou: boolean;
}): number {
  if (opts.attention === "confirm") return 0;
  if (opts.attention === "working" || opts.runningCount > 0) return 1;
  if (opts.needsYou) return 2;
  return 3;
}

/** 正在进行的项目：有存活 Agent 或该方式下「要你管」。最多 5 条，第一条最大。 */
export function pickWorkbenchNow(input: {
  seeds: readonly WorkbenchNowSeed[];
  runs: readonly RunOverviewInput[];
  isWindows?: boolean;
}): WorkbenchNowItem[] {
  const isWindows = input.isWindows ?? false;
  const groups: PathGroup[] = input.seeds.map((s) => ({
    key: s.path,
    roots: [s.path, ...(s.extraRoots ?? [])],
    registered: s.registered,
  }));
  const live = buildRunOverview([...input.runs]).items.filter(isLiveWork);
  const byPath = new Map<string, WorkbenchNowItem>();

  function ensure(path: string, source: WorkbenchHeroSource): WorkbenchNowItem {
    const seed = input.seeds.find((s) => samePath(s.path, path, isWindows));
    const key = seed?.path ?? path;
    const existing = byPath.get(key);
    if (existing) return existing;
    const item: WorkbenchNowItem = {
      name: seed?.name ?? cwdBasename(path) ?? path,
      path: key,
      registered: seed?.registered ?? false,
      tabId: null,
      agentId: null,
      model: null,
      attention: null,
      runningCount: 0,
      runs: [],
      source,
      workMode: seed?.workMode ?? null,
      subtitle: seed?.subtitle ?? null,
      rank: 3,
    };
    byPath.set(key, item);
    return item;
  }

  for (const run of live) {
    const key = attributePath(run.cwd, groups, isWindows) ?? run.cwd;
    const item = ensure(key, "running");
    item.runs.push(toRunChip(run));
  }

  for (const seed of input.seeds) {
    if (!seed.needsYou && !byPath.has(seed.path)) continue;
    const item = ensure(seed.path, byPath.has(seed.path) ? "running" : "recent-registered");
    if (!item.subtitle) item.subtitle = seed.subtitle;
    if (!item.workMode) item.workMode = seed.workMode;
  }

  const items = [...byPath.values()].map((item) => {
    const seed = input.seeds.find((s) => samePath(s.path, item.path, isWindows));
    const runs = sortRunChips(item.runs);
    const pointer = pointerFromRuns(runs);
    return {
      ...item,
      runs,
      runningCount: runs.length,
      tabId: pointer.tabId,
      agentId: pointer.agentId,
      attention: pointer.attention,
      rank: nowRank({
        attention: pointer.attention,
        runningCount: runs.length,
        needsYou: seed?.needsYou ?? false,
      }),
    };
  });
  items.sort((a, b) => a.rank - b.rank);
  return items.slice(0, 5);
}

export function continueWorkbenchTarget(hero: WorkbenchHero): WorkbenchContinue {
  if (hero.tabId) return { kind: "terminal", tabId: hero.tabId };
  if (hero.registered) return { kind: "project", path: hero.path };
  return { kind: "enter-cwd", path: hero.path };
}

/** 流水线里第一个尚未合并的步骤名；全做完回末步；没有步骤返回 null */
export function firstOpenStepName(
  steps: readonly {
    name: string;
    workspaceName: string;
    seedComplete?: boolean;
  }[],
  workspaces: readonly Pick<
    WorkbenchWorkspaceRef,
    "name" | "status" | "mergedAt"
  >[],
): string | null {
  if (steps.length === 0) return null;
  for (const step of steps) {
    if (step.seedComplete) continue;
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
    if (opts.runningCount === 1) {
      if (opts.attention === "confirm") return `${who} 在等你确认`;
      return `${who} 正在工作`;
    }
    if (opts.attention === "confirm") {
      return `${opts.runningCount} 个 Agent 在跑 · ${who} 在等你确认`;
    }
    return `${opts.runningCount} 个 Agent 在跑`;
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

/** 工作台「最近对话」：有标题才列，默认最多 10 条（沿用传入顺序，通常已按 updated_at 降序）。 */
export function workbenchRecentSessions<T extends {
  customTitle: string | null;
  title: string | null;
}>(sessions: readonly T[], limit = WORKBENCH_RECENT_LIMIT): T[] {
  const out: T[] = [];
  for (const session of sessions) {
    if (!namedSessionTitle(session)) continue;
    out.push(session);
    if (out.length >= limit) break;
  }
  return out;
}
