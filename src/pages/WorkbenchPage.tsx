import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight,
  CircleDot,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
} from "lucide-react";
import { useAppStore, runInboxAction } from "../store";
import { abbrevHome, samePath } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { relTime } from "../rel-time";
import { alertDialog } from "../components/ConfirmDialog";
import { AGENTS } from "../types";
import type {
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
} from "../workbench-hero";
import {
  EmptyState,
  PageFrame,
  PageHeader,
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
  const inboxItems = useAppStore((s) => s.inboxItems);
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
      .then(setProjects)
      .catch(() => {});
    invoke<WorkspaceDto[]>("list_workspaces")
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [visible, runCwdSig]);

  const hero = useMemo(
    () =>
      pickWorkbenchHero({
        projects,
        recentRepos,
        workspaces,
        runs: terminalRunInputs,
        contextName: contextLabel?.project ?? null,
        isWindows: IS_WINDOWS,
      }),
    [projects, recentRepos, workspaces, terminalRunInputs, contextLabel],
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
    if (!hero?.registered) return null;
    const mine = workspaces.filter((w) =>
      samePath(w.repoPath, hero.path, IS_WINDOWS),
    );
    return firstOpenStepName(steps, mine);
  }, [hero, steps, workspaces]);

  const recentSessions = useMemo(() => {
    const rows: { agent: string; sessionId: string; title: string; updatedAt: string | null }[] =
      [];
    for (const session of sessions) {
      const title = namedSessionTitle(session);
      if (!title) continue;
      rows.push({
        agent: session.agent,
        sessionId: session.sessionId,
        title,
        updatedAt: session.updatedAt,
      });
      if (rows.length >= 6) break;
    }
    return rows;
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
            <h2 className="text-xs font-medium text-l2">继续当前工作</h2>
            {hero && hero.runningCount > 0 && (
              <span className="rounded-full bg-ok px-2 py-0.5 text-micro text-ok-text">
                {hero.runningCount} 个运行中
              </span>
            )}
          </div>

          {hero ? (
            <div className="rounded-lg border border-hairline bg-raised/55 p-5 shadow-[0_1px_0_rgb(255_255_255_/_.02)]">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <p className="truncate text-xl font-medium tracking-tight text-l1">
                    {hero.name}
                  </p>
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
                <span>{statusText}</span>
              </div>
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
          {recentRepos.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近打开的项目会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentRepos.slice(0, 5).map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  className="group flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors hover:bg-hover"
                  onClick={() => void enterRepo(repo)}
                >
                  <FolderOpen size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">{repo.name}</span>
                  <span className="shrink-0 text-micro text-l4">{relTime(repo.lastActive)}</span>
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
                  <span className="shrink-0 text-micro text-l4">{relTime(session.updatedAt)}</span>
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
