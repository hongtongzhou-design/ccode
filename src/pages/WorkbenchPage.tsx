import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  CircleDot,
  FolderOpen,
  MessageSquare,
  MessagesSquare,
} from "lucide-react";
import { useAppStore, runInboxAction } from "../store";
import { buildRunOverview } from "../run-overview";
import { relTime } from "../rel-time";
import {
  EmptyState,
  PageFrame,
  PageHeader,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";

function sessionTitle(session: {
  customTitle: string | null;
  title: string | null;
}): string {
  return session.customTitle?.trim() || session.title?.trim() || "未命名对话";
}

const iconClass = "shrink-0 text-l4";

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
  const liveSessions = useAppStore((s) => s.liveSessions);
  const inboxItems = useAppStore((s) => s.inboxItems);
  const sessions = useAppStore((s) => s.sessions);
  const recentRepos = useAppStore((s) => s.recentRepos);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);

  useEffect(() => {
    if (visible) void loadRecentRepos();
  }, [loadRecentRepos, visible]);

  const runOverview = useMemo(
    () => buildRunOverview(terminalRunInputs),
    [terminalRunInputs],
  );
  const runningCount =
    runOverview.items.filter((item) => item.running).length ||
    Object.keys(liveSessions).length;
  const recentSessions = sessions.slice(0, 6);
  const currentProject = contextLabel?.project ?? recentRepos[0]?.name ?? null;
  const hasProjectContext = Boolean(contextLabel?.project);

  return (
    <PageFrame width="fluid" className="pb-12">
      <PageHeader
        title="工作台"
        meta={
          currentProject
            ? `${currentProject}${contextLabel?.step ? ` · ${contextLabel.step}` : ""}`
            : "从当前工作开始"
        }
        actions={
          <>
            <button type="button" className={secondaryActionClass} onClick={onQuickChat}>
              快速开聊
            </button>
            <button
              type="button"
              className={primaryActionClass}
              onClick={() => setPage("workspaces")}
            >
              添加项目
            </button>
          </>
        }
      />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.42fr)]">
        <section className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2 px-1">
            <CircleDot size={14} strokeWidth={1.8} className="text-nav-accent" aria-hidden="true" />
            <h2 className="text-xs font-medium text-l2">继续当前工作</h2>
            {runningCount > 0 && (
              <span className="rounded-full bg-ok px-2 py-0.5 text-micro text-ok-text">
                {runningCount} 个运行中
              </span>
            )}
          </div>

          {currentProject ? (
            <div className="rounded-lg border border-hairline bg-raised/55 p-5 shadow-[0_1px_0_rgb(255_255_255_/_.02)]">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <p className="truncate text-xl font-medium tracking-tight text-l1">
                    {currentProject}
                  </p>
                  <p className="mt-1 text-sm text-l3">
                    {contextLabel?.step ?? (hasProjectContext ? "项目上下文已就绪" : "最近打开的项目")}
                  </p>
                  {recentRepos[0]?.path && recentRepos[0].name === currentProject && (
                    <p
                      className="mt-3 truncate font-mono text-micro text-l4"
                      title={recentRepos[0].path}
                    >
                      {recentRepos[0].path}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => setPage("workspaces")}
                >
                  继续工作
                </button>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-xs text-l4">
                <span className="size-1.5 rounded-full bg-ok-text" />
                <span>
                  {runningCount > 0
                    ? "Agent 正在工作"
                    : hasProjectContext
                      ? "准备好从上次位置继续"
                      : "可从最近位置继续"}
                </span>
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

        <section className="min-w-0">
          <SectionHeading
            icon={CircleDot}
            title="待你处理"
            action={
              inboxItems.length > 0 ? (
                <span className="rounded-full bg-warn px-2 py-0.5 text-micro text-warn-text">
                  {inboxItems.length}
                </span>
              ) : undefined
            }
          />
          {inboxItems.length === 0 ? (
            <p className="rounded-md bg-strip/60 px-3 py-4 text-sm text-l3">
              暂时没有待处理事项。
            </p>
          ) : (
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
          )}
        </section>
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
                  onClick={() => setPage("workspaces")}
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
                  onClick={() => setPage("sessions")}
                >
                  <MessageSquare size={15} strokeWidth={1.8} className={iconClass} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">{sessionTitle(session)}</span>
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
