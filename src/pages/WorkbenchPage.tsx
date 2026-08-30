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
import { abbrevHome } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import { buildRunOverview } from "../run-overview";
import { relTime } from "../rel-time";
import { alertDialog } from "../components/ConfirmDialog";
import type { ProjectDto, RepoDto } from "../types";
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

/** 与 WorkspacesPage samePath 同口径：统一分隔符 + 去尾部斜杠 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
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
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);

  // 已注册项目列表：区分跳转落点（已注册 → 项目详情；未注册 → 终端真进入）
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [homeDir, setHomeDir] = useState("");

  useEffect(() => {
    if (visible) void loadRecentRepos();
  }, [loadRecentRepos, visible]);

  useEffect(() => {
    void invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible) return;
    invoke<ProjectDto[]>("list_projects")
      .then(setProjects)
      .catch(() => {});
  }, [visible]);

  /** 最近项目/继续工作的统一点击落点：已注册 → 选中项目详情；
      未注册（外部终端干的活）→ 终端「真进入」（同终端页最近项目口径，先验证目录仍在） */
  async function enterRepo(repo: RepoDto) {
    const registered = projects.find((p) => samePath(p.path, repo.path));
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

  const runOverview = useMemo(
    () => buildRunOverview(terminalRunInputs),
    [terminalRunInputs],
  );
  const runningCount =
    runOverview.items.filter((item) => item.running).length ||
    Object.keys(liveSessions).length;
  const recentSessions = sessions.slice(0, 6);
  const hero = useMemo(() => {
    if (contextLabel?.project) {
      const byName = projects.find((p) => p.name === contextLabel.project);
      const byRecent = recentRepos.find((r) => r.name === contextLabel.project);
      return {
        name: contextLabel.project,
        path: byName?.path ?? byRecent?.path ?? null,
        registered: true,
      };
    }
    const registeredRepo = recentRepos.find((r) =>
      projects.some((p) => samePath(p.path, r.path)),
    );
    if (registeredRepo)
      return { name: registeredRepo.name, path: registeredRepo.path, registered: true };
    if (recentRepos[0])
      return { name: recentRepos[0].name, path: recentRepos[0].path, registered: false };
    return null;
  }, [contextLabel, projects, recentRepos]);
  const currentProject = hero?.name ?? null;
  const hasProjectContext = Boolean(hero?.registered);
  const recentProjectRows = useMemo(
    () =>
      [...recentRepos].sort((a, b) => {
        const ar = projects.some((p) => samePath(p.path, a.path)) ? 0 : 1;
        const br = projects.some((p) => samePath(p.path, b.path)) ? 0 : 1;
        return ar - br;
      }),
    [projects, recentRepos],
  );

  return (
    <PageFrame width="fluid" className="pb-12">
      <PageHeader
        title="工作台"
        meta={contextLabel?.step ?? "从当前工作开始"}
        actions={
          <button type="button" className={secondaryActionClass} onClick={onQuickChat}>
            快速开聊
          </button>
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
                  {hero?.path && (
                    <p
                      className="mt-3 truncate font-mono text-micro text-l4"
                      title={hero.path}
                    >
                      {homeDir
                        ? abbrevHome(hero.path, homeDir, IS_WINDOWS)
                        : hero.path}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={primaryActionClass}
                  onClick={() => {
                    // 有项目上下文 = 回项目详情（项目页保留上次选中）；
                    // 回落到最近仓库（可能未在 Ccode 注册）= 按统一点击落点跳转
                    if (hasProjectContext) setPage("workspaces");
                    else if (hero?.path) {
                      const repo = recentRepos.find((r) => samePath(r.path, hero.path!));
                      if (repo) void enterRepo(repo);
                      else setPage("workspaces");
                    }
                  }}
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

        {inboxItems.length > 0 && (
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
          {inboxItems.length === 0 ? null : (
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
          {recentProjectRows.length === 0 ? (
            <p className="py-5 text-sm text-l3">最近打开的项目会显示在这里。</p>
          ) : (
            <div className="space-y-0.5">
              {recentProjectRows.slice(0, 5).map((repo) => (
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
                    // 精确打开该会话回放（对话页按 agent+sessionId 定位，
                    // 同终端页「⤴对话」口径），不只是进对话页
                    setOpenSessionReq({
                      agent: session.agent,
                      sessionId: session.sessionId,
                    });
                    setPage("sessions");
                  }}
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
