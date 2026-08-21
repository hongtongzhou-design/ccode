import { useEffect, useMemo } from "react";
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
  const runningCount = runOverview.items.filter((item) => item.running).length ||
    Object.keys(liveSessions).length;
  const recentSessions = sessions.slice(0, 6);
  const currentProject = contextLabel?.project ?? recentRepos[0]?.name ?? null;

  return (
    <PageFrame width="wide" className="pb-10">
      <PageHeader
        title="工作台"
        meta={
          currentProject
            ? `${currentProject}${contextLabel?.step ? ` · ${contextLabel.step}` : ""}`
            : "从当前工作开始"
        }
        actions={
          <>
            <button
              type="button"
              className={secondaryActionClass}
              onClick={onQuickChat}
            >
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

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <section className="rounded-lg bg-strip p-4">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-l1">当前工作</h2>
              <p className="mt-1 text-xs text-l3">回到最近一次停下的地方。</p>
            </div>
            {runningCount > 0 && (
              <span className="rounded-full bg-ok px-2 py-1 text-micro text-ok-text">
                {runningCount} 个运行中
              </span>
            )}
          </div>

          {currentProject ? (
            <div className="rounded-md bg-inset p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-l1">
                    {currentProject}
                  </p>
                  <p className="mt-1 text-xs text-l3">
                    {contextLabel?.step ?? "项目上下文已就绪"}
                  </p>
                </div>
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => setPage("workspaces")}
                >
                  继续工作
                </button>
              </div>
              {recentRepos[0]?.path && (
                <p className="mt-3 truncate font-mono text-micro text-l4" title={recentRepos[0].path}>
                  {recentRepos[0].path}
                </p>
              )}
            </div>
          ) : (
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
          )}
        </section>

        <section className="rounded-lg bg-strip p-4">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-medium text-l1">待你处理</h2>
              <p className="mt-1 text-xs text-l3">需要确认或继续的事情。</p>
            </div>
            {inboxItems.length > 0 && (
              <span className="rounded-full bg-warn px-2 py-1 text-micro text-warn-text">
                {inboxItems.length}
              </span>
            )}
          </div>
          {inboxItems.length === 0 ? (
            <p className="py-6 text-sm text-l3">暂时没有待处理事项。</p>
          ) : (
            <div className="space-y-1">
              {inboxItems.slice(0, 5).map((item) => (
                <div
                  key={item.key}
                  className="group flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-hover"
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

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-lg bg-strip p-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-l1">最近产出</h2>
            <button
              type="button"
              className={secondaryActionClass}
              onClick={() => setPage("workspaces")}
            >
              查看项目
            </button>
          </div>
          {recentRepos.length === 0 ? (
            <p className="py-5 text-sm text-l3">项目产出会显示在这里。</p>
          ) : (
            <div className="space-y-1">
              {recentRepos.slice(0, 5).map((repo) => (
                <button
                  key={repo.path}
                  type="button"
                  className="flex min-h-9 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-hover"
                  onClick={() => setPage("workspaces")}
                >
                  <span className="text-l4">⛁</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {repo.name}
                  </span>
                  <span className="shrink-0 text-micro text-l4">
                    {relTime(repo.lastActive)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg bg-strip p-4">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium text-l1">最近对话</h2>
            <button
              type="button"
              className={secondaryActionClass}
              onClick={() => setPage("sessions")}
            >
              查看对话
            </button>
          </div>
          {recentSessions.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近对话会显示在这里。</p>
          ) : (
            <div className="space-y-1">
              {recentSessions.map((session) => (
                <button
                  key={`${session.agent}:${session.sessionId}`}
                  type="button"
                  className="flex min-h-9 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-hover"
                  onClick={() => setPage("sessions")}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-ok-text" />
                  <span className="min-w-0 flex-1 truncate text-sm text-l2">
                    {sessionTitle(session)}
                  </span>
                  <span className="shrink-0 text-micro text-l4">
                    {relTime(session.updatedAt)}
                  </span>
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
