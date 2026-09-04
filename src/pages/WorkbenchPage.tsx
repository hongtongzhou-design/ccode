import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  CircleDot,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
  SquareArrowOutUpRight,
} from "lucide-react";
import { useAppStore, runInboxAction, visibleInboxItems } from "../store";
import { abbrevHome, pathWithin, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import {
  canOpenCodexClient,
  codexNewThreadDeeplink,
} from "../codex-client";
import { absTime, relTime } from "../rel-time";
import { alertDialog } from "../components/ConfirmDialog";
import { AGENTS } from "../types";
import type {
  CodingOverviewDto,
  ProjectConfigReadDto,
  ProjectDto,
  ProjectStepDto,
  RepoDto,
  WorkspaceDto,
} from "../types";
import {
  continueWorkbenchTarget,
  firstOpenStepName,
  heroStatusLine,
  namedSessionTitle,
  pickWorkbenchHero,
  pickWorkbenchNow,
  workbenchRecentRows,
  workbenchRecentSessions,
  type WorkbenchNowSeed,
} from "../workbench-hero";
import {
  CODING_KIND_LABEL,
  WORK_MODE_LABEL,
  deriveCodingKind,
  isOfficeInProgress,
  normalizeWorkMode,
} from "../work-mode";
import {
  EmptyState,
  PageFrame,
  PageHeader,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";

const iconClass = "shrink-0 text-l4";

function agentLabel(id: string | null): string | null {
  if (!id) return null;
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

function SectionHeading({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2 px-1">
      <Icon size={14} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
      <h2 className="text-xs font-medium text-l2">{title}</h2>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function WorkbenchPage({
  visible,
  onQuickChat,
}: {
  visible?: boolean;
  onQuickChat: () => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const contextLabel = useAppStore((s) => s.contextLabel);
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const rawInboxItems = useAppStore((s) => s.inboxItems);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const inboxDismissed = useAppStore((s) => s.inboxDismissed);
  const inboxItems = visibleInboxItems(
    rawInboxItems,
    appUpdate
      ? { version: appUpdate.version, currentVersion: appUpdate.currentVersion }
      : null,
    inboxDismissed,
  );
  const sessions = useAppStore((s) => s.sessions);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);

  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceDto[]>([]);
  const [steps, setSteps] = useState<ProjectStepDto[]>([]);
  const [homeDir, setHomeDir] = useState("");
  const [codingByPath, setCodingByPath] = useState<
    Record<string, CodingOverviewDto>
  >({});
  const [researchSteps, setResearchSteps] = useState<
    Record<string, ProjectStepDto[]>
  >({});

  useEffect(() => {
    if (visible) void loadRecentRepos();
  }, [loadRecentRepos, visible]);

  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);

  const runCwdSig = terminalRunInputs
    .filter((item) => item.running || item.attention === "confirm")
    .map((item) => item.cwd)
    .join("\n");

  useEffect(() => {
    if (!visible) return;
    invoke<ProjectDto[]>("list_projects")
      .then((list) => {
        setProjects(list);
        const coding = list.filter(
          (p) => normalizeWorkMode(p.workMode) === "coding",
        );
        const research = list.filter(
          (p) => normalizeWorkMode(p.workMode) === "research",
        );
        void Promise.all(
          coding.map((p) =>
            invoke<CodingOverviewDto>("coding_overview", { repoPath: p.path })
              .then((ov) => [p.path, ov] as const)
              .catch(() => null),
          ),
        ).then((rows) => {
          const next: Record<string, CodingOverviewDto> = {};
          for (const row of rows) {
            if (row) next[row[0]] = row[1];
          }
          setCodingByPath(next);
        });
        void Promise.all(
          research.map((p) =>
            invoke<ProjectConfigReadDto>("read_project_config", { path: p.path })
              .then((read) => [p.path, read.config.steps ?? []] as const)
              .catch(() => null),
          ),
        ).then((rows) => {
          const next: Record<string, ProjectStepDto[]> = {};
          for (const row of rows) {
            if (row) next[row[0]] = row[1];
          }
          setResearchSteps(next);
        });
      })
      .catch(() => {});
    invoke<WorkspaceDto[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [visible, runCwdSig]);

  const nowSeeds = useMemo((): WorkbenchNowSeed[] => {
    const live = terminalRunInputs.filter(
      (r) => r.running || r.attention === "confirm",
    );
    return projects.map((p) => {
      const mode = normalizeWorkMode(p.workMode);
      const mineWs = workspaces.filter(
        (w) =>
          w.status !== "archived" && samePath(w.repoPath, p.path, IS_WINDOWS),
      );
      const extraRoots = [
        ...mineWs.map((w) => w.worktreePath),
        ...(codingByPath[p.path]?.worktrees.map((w) => w.path) ?? []),
      ];
      let subtitle: string | null = null;
      let needsYou = false;
      if (mode === "research") {
        const st = researchSteps[p.path] ?? steps;
        subtitle = firstOpenStepName(st, mineWs);
        needsYou = mineWs.some((w) => w.status === "active" && !w.mergedAt);
      } else if (mode === "coding") {
        const ov = codingByPath[p.path];
        if (ov) {
          const rows = [
            ...ov.worktrees.map((w) => ({
              name: w.branch || "工作树",
              kind: deriveCodingKind({
                isBase: w.isBase,
                isPrimary: w.isPrimary,
                dirty: w.dirty,
                ahead: w.ahead,
                behind: w.behind,
                hasWorktree: true,
              }),
            })),
            ...ov.branches
              .filter((b) => !b.worktreePath)
              .map((b) => ({
                name: b.name,
                kind: deriveCodingKind({
                  isBase: b.isBase,
                  isPrimary: b.isPrimary,
                  dirty: b.dirty,
                  ahead: b.ahead,
                  behind: b.behind,
                  hasWorktree: false,
                }),
              })),
          ];
          const top =
            rows.find((x) => x.kind === "sync") ??
            rows.find((x) => x.kind === "ready") ??
            rows.find((x) => x.kind === "dev");
          if (top) {
            subtitle = `${top.name} ${CODING_KIND_LABEL[top.kind]}`;
            needsYou = true;
          }
        }
      } else {
        const lastSession =
          sessions
            .filter((s) => samePath(s.projectPath, p.path, IS_WINDOWS))
            .map((s) => s.updatedAt)
            .filter((x): x is string => !!x)
            .sort()
            .pop() ?? null;
        const hasLive = live.some((r) =>
          extraRoots
            .concat(p.path)
            .some((root) => pathWithin(r.cwd, root, IS_WINDOWS)),
        );
        needsYou = isOfficeInProgress({
          hasLiveTab: hasLive,
          lastSessionAt: lastSession,
          lastOpenedAt: null,
        });
        subtitle = lastSession ? "最近有文档对话" : null;
      }
      const hasLive = live.some((r) =>
        extraRoots
          .concat(p.path)
          .some((root) => pathWithin(r.cwd, root, IS_WINDOWS)),
      );
      return {
        path: p.path,
        name: p.name,
        registered: true,
        workMode: mode,
        subtitle,
        needsYou: needsYou || hasLive,
        extraRoots,
      };
    });
  }, [
    projects,
    workspaces,
    codingByPath,
    researchSteps,
    steps,
    sessions,
    terminalRunInputs,
  ]);

  const nowItems = useMemo(
    () =>
      pickWorkbenchNow({
        seeds: nowSeeds,
        runs: terminalRunInputs,
        isWindows: IS_WINDOWS,
      }),
    [nowSeeds, terminalRunInputs],
  );

  const wbProjects = useMemo(
    () =>
      projects.map((p) => ({
        path: p.path,
        name: p.name,
        workMode: normalizeWorkMode(p.workMode),
        lastOpenedAt: p.lastOpenedAt,
        createdAt: p.createdAt,
      })),
    [projects],
  );

  const hero = useMemo(() => {
    if (nowItems[0]) return nowItems[0];
    return pickWorkbenchHero({
      projects: wbProjects,
      recentRepos,
      workspaces,
      runs: terminalRunInputs,
      contextName: contextLabel?.project ?? null,
      isWindows: IS_WINDOWS,
    });
  }, [nowItems, wbProjects, recentRepos, workspaces, terminalRunInputs, contextLabel]);

  const recentRows = useMemo(
    () =>
      workbenchRecentRows({
        recentRepos,
        projects: wbProjects,
        isWindows: IS_WINDOWS,
      }),
    [recentRepos, wbProjects],
  );

  useEffect(() => {
    if (!visible || !hero?.registered) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    invoke<ProjectConfigReadDto>("read_project_config", { path: hero.path })
      .then((read) => {
        if (!cancelled) setSteps(read.config.steps ?? []);
      })
      .catch(() => {
        if (!cancelled) setSteps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, hero?.registered, hero?.path]);

  async function enterRepo(repo: RepoDto) {
    const registered = projects.find((p) =>
      samePath(p.path, repo.path, IS_WINDOWS),
    );
    if (registered) {
      setSelectProjectReq(registered.path);
      setPage("workspaces");
      return;
    }
    try {
      await invoke("list_dir", { path: repo.path, showHidden: false });
    } catch {
      await alertDialog(`目录不存在或已移动：${repo.path}`);
      return;
    }
    setEnterCwdReq(repo.path);
    setPage("terminal");
  }

  async function openInCodex(absPath: string) {
    try {
      await openUrl(codexNewThreadDeeplink(absPath));
    } catch (e) {
      await alertDialog(`唤起 Codex 客户端失败：${e}`);
    }
  }

  const showCodexJump = canOpenCodexClient();

  async function continueWork() {
    if (!hero) return;
    const target = continueWorkbenchTarget(hero);
    if (target.kind === "terminal") {
      setFocusTabReq(target.tabId);
      setPage("terminal");
      return;
    }
    if (target.kind === "project") {
      setSelectProjectReq(target.path);
      setPage("workspaces");
      return;
    }
    const repo = recentRepos.find((r) =>
      samePath(r.path, target.path, IS_WINDOWS),
    );
    if (repo) {
      await enterRepo(repo);
      return;
    }
    try {
      await invoke("list_dir", { path: target.path, showHidden: false });
    } catch {
      await alertDialog(`目录不存在或已移动：${target.path}`);
      return;
    }
    setEnterCwdReq(target.path);
    setPage("terminal");
  }

  const stepName = useMemo(() => {
    if (nowItems[0]?.subtitle) return nowItems[0].subtitle;
    if (!hero?.registered) return null;
    const mine = workspaces.filter((w) =>
      samePath(w.repoPath, hero.path, IS_WINDOWS),
    );
    return firstOpenStepName(steps, mine);
  }, [hero, steps, workspaces, nowItems]);

  const recentSessions = useMemo(() => {
    return workbenchRecentSessions(sessions).map((session) => ({
      agent: session.agent,
      sessionId: session.sessionId,
      title: namedSessionTitle(session) ?? session.title ?? "",
      updatedAt: session.updatedAt,
    }));
  }, [sessions]);

  const hasInbox = inboxItems.length > 0;
  const statusText = hero
    ? heroStatusLine({
        runningCount: hero.runningCount,
        agentLabel: agentLabel(hero.agentId),
        attention: hero.attention,
        registered: hero.registered,
      })
    : "";
  const statusDot =
    hero?.attention === "confirm"
      ? "bg-warn-text"
      : hero && hero.runningCount > 0
        ? "bg-ok-text"
        : "bg-l4";
  const runningBadge = nowItems.reduce((n, item) => n + item.runningCount, 0)
    || (hero?.runningCount ?? 0);
  function itemDot(item: {
    attention: "confirm" | "working" | "done" | null;
    runningCount: number;
  }): string {
    if (item.attention === "confirm") return "bg-warn-text";
    if (item.runningCount > 0) return "bg-ok-text";
    return "bg-l4";
  }

  return (
    <PageFrame width="fluid" className="pb-12">
      <PageHeader
        title="工作台"
        meta={stepName ?? "从当前工作开始"}
        actions={
          <button type="button" className={secondaryActionClass} onClick={onQuickChat}>
            快速开聊
          </button>
        }
      />

      <div
        className={
          hasInbox
            ? "grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]"
            : undefined
        }
      >
        <section className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <CircleDot size={14} strokeWidth={1.8} className="text-nav-accent" aria-hidden="true" />
            <h2 className="text-xs font-medium text-l2">
              {nowItems.length > 1 ? "正在进行" : "继续当前工作"}
            </h2>
            {runningBadge > 0 && (
              <span className="rounded-full bg-ok px-2 py-0.5 text-micro text-ok-text">
                {runningBadge} 个运行中
              </span>
            )}
          </div>

          {hero ? (
            <div className="space-y-2">
            <div className="rounded-lg border border-hairline bg-raised/55 p-5 shadow-[0_1px_0_rgb(255_255_255_/_.02)]">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <p className="truncate text-xl font-medium tracking-tight text-l1">
                    {hero.name}
                  </p>
                  {hero.workMode ? (
                    <span className="mt-1 inline-block rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                      {WORK_MODE_LABEL[hero.workMode]}
                    </span>
                  ) : null}
                  {stepName && (
                    <p className="mt-1 text-sm text-l3">{stepName}</p>
                  )}
                  <p
                    className="mt-3 truncate font-mono text-micro text-l4"
                    title={hero.path}
                  >
                    {homeDir
                      ? abbrevHome(hero.path, homeDir, IS_WINDOWS)
                      : hero.path}
                  </p>
                </div>
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => void continueWork()}
                >
                  继续工作
                </button>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-xs text-l4">
                <span className={`size-1.5 rounded-full ${statusDot}`} />
                <span className="min-w-0 flex-1 truncate">{statusText}</span>
                {showCodexJump && (
                  <button
                    type="button"
                    className={`${ghostActionClass} h-auto shrink-0 px-1.5 py-0.5 text-micro text-l4 hover:text-l2`}
                    title="在 Codex 客户端打开这个目录"
                    onClick={() => void openInCodex(hero.path)}
                  >
                    在 Codex 打开
                  </button>
                )}
              </div>
            </div>
            {nowItems.slice(1).map((item) => (
              <div
                key={item.path}
                className="group flex min-h-10 w-full items-center gap-3 rounded-lg border border-hairline bg-raised/40 px-4 py-2.5 hover:bg-hover"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => {
                    const target = continueWorkbenchTarget(item);
                    if (target.kind === "terminal") {
                      setFocusTabReq(target.tabId);
                      setPage("terminal");
                      return;
                    }
                    if (target.kind === "project") {
                      setSelectProjectReq(target.path);
                      setPage("workspaces");
                    }
                  }}
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${itemDot(item)}`}
                  />
                  <span className="shrink-0 rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                    {item.workMode ? WORK_MODE_LABEL[item.workMode] : "项目"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {item.name}
                    {item.subtitle ? (
                      <span className="ml-2 text-l4">{item.subtitle}</span>
                    ) : null}
                  </span>
                  {item.runningCount > 0 && (
                    <span className="shrink-0 text-micro text-ok-text">
                      {item.runningCount} 个运行中
                    </span>
                  )}
                  <span className="shrink-0 text-micro text-l4">继续</span>
                </button>
                {showCodexJump && (
                  <button
                    type="button"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                    title="在 Codex 客户端打开这个目录"
                    aria-label="在 Codex 客户端打开"
                    onClick={() => void openInCodex(item.path)}
                  >
                    <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-field bg-strip px-5 py-8">
              <EmptyState
                compact
                title="从一个项目开始"
                detail="添加项目后，Ccode 会从上次停下的地方继续。"
                action={
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      className={primaryActionClass}
                      onClick={() => setPage("workspaces")}
                    >
                      添加项目
                    </button>
                    <button
                      type="button"
                      className={secondaryActionClass}
                      onClick={() => setPage("terminal")}
                    >
                      打开运行
                    </button>
                  </div>
                }
              />
            </div>
          )}
        </section>

        {hasInbox && (
        <section className="min-w-0">
          <SectionHeading
            icon={CircleDot}
            title="待你处理"
            action={
              <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">
                {inboxItems.length}
              </span>
            }
          />
          <div className="space-y-0.5">
            {inboxItems.slice(0, 5).map((item) => (
              <div
                key={item.key}
                className="group flex min-h-10 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-hover"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${item.dot}`} />
                <span className="min-w-0 flex-1 truncate text-xs text-l2">
                  {item.text}
                </span>
                <button
                  type="button"
                  className={`${rowActionClass} opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100`}
                  onClick={() => runInboxAction(item)}
                >
                  {item.actionLabel}
                </button>
              </div>
            ))}
          </div>
        </section>
        )}
      </div>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section className="min-w-0">
          <SectionHeading
            icon={FolderOpen}
            title="最近项目"
            action={
              <button type="button" className={rowActionClass} onClick={() => setPage("workspaces")}>
                查看全部
              </button>
            }
          />
          {recentRows.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近打开的项目会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentRows.map((row) => (
                <div
                  key={row.path}
                  className="group flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 transition-colors hover:bg-hover"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    title={
                      row.registered
                        ? row.path
                        : "还没添加到 Ccode，点开会进运行页"
                    }
                    onClick={() =>
                      void enterRepo({
                        path: row.path,
                        name: row.name,
                        lastActive: row.lastActive,
                      })
                    }
                  >
                    <FolderOpen size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-l2">
                      {row.name}
                    </span>
                  </button>
                  {!row.registered && (
                    <span className="shrink-0 text-micro text-l4">未添加</span>
                  )}
                  <span
                    className="shrink-0 text-micro text-l4"
                    title={absTime(row.lastActive)}
                  >
                    {relTime(row.lastActive)}
                  </span>
                  {showCodexJump && (
                    <button
                      type="button"
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                      title="在 Codex 客户端打开这个目录"
                      aria-label="在 Codex 客户端打开"
                      onClick={() => void openInCodex(row.path)}
                    >
                      <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className={`text-l4 ${hoverRevealClass}`}
                    aria-hidden="true"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0">
          <SectionHeading
            icon={MessagesSquare}
            title="最近对话"
            action={
              <button type="button" className={rowActionClass} onClick={() => setPage("sessions")}>
                查看全部
              </button>
            }
          />
          {recentSessions.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近对话会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentSessions.map((session) => (
                <button
                  key={`${session.agent}:${session.sessionId}`}
                  type="button"
                  className="group flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors hover:bg-hover"
                  onClick={() => {
                    setOpenSessionReq({
                      agent: session.agent,
                      sessionId: session.sessionId,
                    });
                    setPage("sessions");
                  }}
                >
                  <MessageSquare size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">{session.title}</span>
                  <span
                    className="shrink-0 text-micro text-l4"
                    title={absTime(session.updatedAt)}
                  >
                    {relTime(session.updatedAt)}
                  </span>
                  <ChevronRight
                    size={14}
                    strokeWidth={1.8}
                    className="text-l4 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

    </PageFrame>
  );
}

export default WorkbenchPage;
