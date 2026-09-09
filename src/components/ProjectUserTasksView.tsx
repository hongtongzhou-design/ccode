import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Play, Plus, RotateCw, Trash2 } from "lucide-react";
import { runInboxAction, useAppStore } from "../store";
import {
  AGENTS,
  type ProjectDto,
  type RunDto,
  type RunEventDto,
  type TaskDto,
  type TaskContextDto,
  type TaskOutputChangeDto,
  type TaskReviewDto,
} from "../types";
import {
  Checkbox,
  compactPrimaryActionClass,
  FoldMark,
  ghostActionClass,
  primaryActionClass,
  projectWellClass,
  rowActionClass,
  secondaryActionClass,
  SegTabs,
} from "./PageFrame";
import { Modal } from "./Modal";
import { agentBrand } from "../agent-colors";
import ProjectSessionsSection, {
  sessionsAsideOpenClass,
} from "./ProjectSessionsSection";
import ScheduleSection from "./ScheduleSection";
import { beginProjectChat } from "./AskAiModal";
import { confirmDialog } from "./ConfirmDialog";
import {
  canSaveDeclaredGoal,
  canSubmitDeclaredTask,
  declaredTaskKindsForMode,
  GOAL_BUCKET_LABEL,
  GOAL_BUCKET_ORDER,
  goalTimeline,
  goalTimelineLabel,
  groupGoalsByBucket,
  goalDisplayName,
  isTaskMaterialNoise,
  joinRunPath,
  parseReviewNote,
  pathCoveredBySelection,
  pathIsProtected,
  relativeProjectPath,
  selectedChangePaths,
  taskChangeKindLabel,
  taskPathsForScope,
  taskStatusLabel,
  toggleTaskMaterialPath,
  visibleDeclaredTasks,
  type TaskMaterialScope,
  type TaskPermission,
} from "../project-tasks";
import type { DirEntryDto } from "./FileTree";
import FileTypeMark from "./FileTypeMark";
import OfficePreviewModal from "./OfficePreviewModal";
import { goalRunTerminalFields, prepareGoalRun } from "../goal-run";
import ProjectRulesPanel from "./ProjectRulesPanel";
import {
  goalReviewCopy,
  goalReviewFacts,
  groupReviewChanges,
} from "../goal-review";
import { goalCardMeta, goalsNeedAttention, projectNowLine } from "../project-status";

function agentLabel(id: string): string {
  return AGENTS.find((agent) => agent.id === id)?.label ?? id;
}

function continueRun(run: RunDto) {
  runInboxAction({
    key: `run:${run.id}`,
    dot: "bg-ok-text",
    text: "运行",
    actionLabel: "打开",
    action: { type: "run", runId: run.id },
  });
}

export default function ProjectUserTasksView({
  project,
  embed = false,
  sessionsCollapsed = false,
  onOpenSessions,
  onUrgentGoals,
}: {
  project: ProjectDto;
  /** 嵌进无流程科研左栏：不重复项目名、不另开对话栏。 */
  embed?: boolean;
  /** 无流程科研：对话收起后，重开按钮放在「目标」标题行，与办公页同一位置。 */
  sessionsCollapsed?: boolean;
  onOpenSessions?: () => void;
  onUrgentGoals?: (urgent: boolean) => void;
}) {
  const profiles = useAppStore((state) => state.profiles);
  const hiddenProfiles = useAppStore((state) => state.settings?.hiddenProfiles ?? []);
  const setPage = useAppStore((state) => state.setPage);
  const setPendingTerminal = useAppStore((state) => state.setPendingTerminal);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [events, setEvents] = useState<RunEventDto[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTask, setReviewTask] = useState<TaskDto | null>(null);
  const taskReviewReq = useAppStore((state) => state.taskReviewReq);
  const setTaskReviewReq = useAppStore((state) => state.setTaskReviewReq);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const withSessions = !embed && project.workMode === "office";
  const [configReady, setConfigReady] = useState(
    embed || project.workMode !== "research",
  );
  const [freeResearch, setFreeResearch] = useState(embed);

  const eligible =
    project.workMode === "office" ||
    embed ||
    (project.workMode === "research" && freeResearch);

  const load = useCallback(async () => {
    if (!eligible) return;
    try {
      const [nextTasks, nextRuns, nextEvents] = await Promise.all([
        invoke<TaskDto[]>("task_list", { projectRoot: project.path }),
        invoke<RunDto[]>("run_list", { projectRoot: project.path }),
        invoke<RunEventDto[]>("task_goal_events", { projectRoot: project.path }),
      ]);
      setTasks(visibleDeclaredTasks(nextTasks, declaredTaskKindsForMode(project.workMode)));
      setRuns(nextRuns);
      setEvents(nextEvents);
      setError(null);
    } catch (reason) {
      setError(`任务读取失败：${String(reason)}`);
    }
  }, [eligible, project.path, project.workMode]);

  useEffect(() => {
    if (project.workMode !== "research") {
      setConfigReady(true);
      setFreeResearch(false);
      return;
    }
    let stale = false;
    invoke<{ config: { steps: unknown[]; pipelineOptOut?: boolean } }>(
      "read_project_config",
      { path: project.path },
    )
      .then((read) => {
        if (stale) return;
        setFreeResearch(
          read.config.steps.length === 0 && read.config.pipelineOptOut === true,
        );
        setConfigReady(true);
      })
      .catch(() => {
        if (!stale) setConfigReady(true);
      });
    return () => {
      stale = true;
    };
  }, [project.path, project.workMode]);

  useEffect(() => {
    void load();
    if (!eligible) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [eligible, load]);

  // 待验收提升是后端事件（goal-review-ready）：立即刷新，不等 2.5s 轮询
  useEffect(() => {
    if (!eligible) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectRoot: string }>("goal-review-ready", (e) => {
      if (e.payload.projectRoot === project.path) void load();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [eligible, load, project.path]);

  useEffect(() => {
    if (!taskReviewReq || !eligible) return;
    if (taskReviewReq.projectRoot !== project.path) return;
    const match = tasks.find((task) => task.id === taskReviewReq.taskId);
    if (match) {
      setReviewTask(match);
      setTaskReviewReq(null);
    }
  }, [eligible, project.path, setTaskReviewReq, taskReviewReq, tasks]);

  const latestRunByTask = useMemo(() => {
    const map = new Map<string, RunDto>();
    for (const run of runs) {
      if (!map.has(run.taskId)) map.set(run.taskId, run);
    }
    return map;
  }, [runs]);
  const buckets = useMemo(() => groupGoalsByBucket(tasks), [tasks]);
  const reviewCopy = goalReviewCopy(project.workMode);
  const nowLine = useMemo(() => projectNowLine(tasks), [tasks]);
  const urgentGoals = useMemo(() => goalsNeedAttention(tasks), [tasks]);

  useEffect(() => {
    onUrgentGoals?.(urgentGoals);
  }, [onUrgentGoals, urgentGoals]);

  const visibleProfiles = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          !hiddenProfiles.includes(profile.id) ||
          profile.id === project.defaultProfiles?.[profile.agent],
      ),
    [hiddenProfiles, profiles, project.defaultProfiles],
  );

  if (!configReady || !eligible) {
    return null;
  }

  async function startTask(
    task: TaskDto,
    opts?: { reuseIsolation?: boolean; feedback?: string },
  ) {
    const preferredAgent = task.agent ?? project.defaultAgent;
    const profile =
      visibleProfiles.find(
        (item) =>
          item.id ===
          (task.profileId ??
            (preferredAgent ? project.defaultProfiles?.[preferredAgent] : undefined)),
      ) ??
      visibleProfiles.find((item) => item.agent === preferredAgent) ??
      visibleProfiles.find((item) => item.agent === "claude-code") ??
      visibleProfiles[0];
    if (!profile) {
      setError("还没有可用连接，先到连接页配一个。");
      setPage("profiles");
      return;
    }
    setStartingId(task.id);
    try {
      // 重试（失败/已停止）且有上一版：复用上次的隔离副本，并尽量恢复上次会话——
      // 「重试」的产品语义是接着干，不是从零复制一份重跑
      const previousRun = latestRunByTask.get(task.id);
      const retrying =
        (task.status === "failed" || task.status === "stopped") && previousRun
          ? previousRun
          : null;
      const { run, prompt } = await prepareGoalRun({
        projectName: project.name,
        projectPath: project.path,
        workMode: project.workMode,
        task,
        agent: profile.agent,
        profileId: profile.id,
        reuseIsolation: opts?.reuseIsolation ?? Boolean(retrying),
        feedback: opts?.feedback,
      });
      setPendingTerminal({
        extraEnv: {},
        title: task.name,
        agentId: profile.agent,
        profileId: profile.id,
        model: profile.models[0] ?? "",
        resume:
          retrying?.sessionId && retrying.agent === profile.agent
            ? { agentId: retrying.agent, sessionId: retrying.sessionId }
            : undefined,
        ...goalRunTerminalFields(task, run, prompt),
      });
      setPage("terminal");
    } catch (reason) {
      setError(`启动任务失败：${String(reason)}`);
    } finally {
      setStartingId(null);
      void load();
    }
  }

  async function deleteGoal(task: TaskDto) {
    const name = goalDisplayName(task);
    const ok = await confirmDialog(
      `删除目标「${name}」？不会改项目里已验收的文件；验收记录会保留在项目档案（.ccode）里，谁接受的、接受了哪一版仍可查。`,
      {
        danger: true,
        confirmText: "删除",
      },
    );
    if (!ok) return;
    setDeletingId(task.id);
    try {
      await invoke("task_delete", { id: task.id });
      if (reviewTask?.id === task.id) setReviewTask(null);
      setError(null);
      await load();
    } catch (reason) {
      setError(`删除目标失败：${String(reason)}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
    <div className="mb-4 flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-0">
      <section className={`min-w-0 flex-1 ${projectWellClass} ${withSessions && sessionsOpen ? "lg:pr-6" : ""}`}>
        <div className="mb-3 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-l1">目标</h2>
            {nowLine && (
              <p className="mt-1 text-sm font-medium text-l1">{nowLine}</p>
            )}
          </div>
          {((withSessions && !sessionsOpen) ||
            (sessionsCollapsed && onOpenSessions)) && (
            <div className="shrink-0">
              <ProjectSessionsSection
                projectPath={project.path}
                variant="sidebar"
                collapsed
                onToggle={onOpenSessions ?? (() => setSessionsOpen(true))}
                title="这个项目的对话"
              />
            </div>
          )}
          <button type="button" className={primaryActionClass} onClick={() => setCreateOpen(true)}>
            <Plus size={13} aria-hidden="true" />
            新建目标
          </button>
          <button type="button" className={rowActionClass} onClick={() => void load()} title="刷新任务">
            <RotateCw size={13} aria-hidden="true" />
          </button>
        </div>
        {error && <p className="mb-2 text-xs text-err-text">{error}</p>}
        {tasks.length === 0 ? null : (
          <div className="space-y-4">
            {GOAL_BUCKET_ORDER.map((bucket) => {
              const rows = buckets[bucket];
              if (rows.length === 0) return null;
              return (
                <div key={bucket}>
                  <h3 className="mb-2 text-micro font-medium text-l4">
                    {bucket === "review"
                      ? reviewCopy.bucketReview
                      : GOAL_BUCKET_LABEL[bucket]}
                  </h3>
                  <ul className="space-y-2">
                    {rows.map((task) => {
                      const run = latestRunByTask.get(task.id);
                      const running = task.status === "running";
                      const taskRuns = runs.filter(
                        (item) => item.taskId === task.id && !item.internal,
                      );
                      const timeline = goalTimelineLabel(
                        goalTimeline({
                          status: task.status,
                          runs: taskRuns,
                          events: events.filter((event) =>
                            taskRuns.some((item) => item.id === event.runId),
                          ),
                          acceptedLabel: reviewCopy.timelineAccepted,
                        }),
                      );
                      const canStart =
                        task.status === "pending" ||
                        task.status === "failed" ||
                        task.status === "stopped";
                      const canRevise =
                        !!run &&
                        (task.status === "pending_review" || task.status === "completed");
                      return (
                        <li key={task.id} className="group rounded-md bg-raised/45 px-3 py-2">
                          <div className="flex items-start gap-3">
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-l1">
                                  {goalDisplayName(task)}
                                </span>
                                <span className="rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                                  {taskStatusLabel(task.status)}
                                </span>
                              </span>
                              {task.description &&
                                task.description.trim() !== goalDisplayName(task) && (
                                <span className="mt-1 block text-xs text-l3">{task.description}</span>
                              )}
                              {timeline && (
                                <span className="mt-1 block text-micro text-l4">{timeline}</span>
                              )}
                              <span className="mt-1 block text-micro text-l4">
                                {goalCardMeta({
                                  agentLabel:
                                    agentLabel(
                                      task.agent ?? run?.agent ?? project.defaultAgent ?? "",
                                    ) || "跟随项目默认",
                                  outputPaths: task.adoptedPaths?.length
                                    ? task.adoptedPaths
                                    : task.outputPaths,
                                  reviewRequired: task.reviewRequired,
                                  workMode: project.workMode,
                                })}
                              </span>
                            </span>
                            {running && run && (
                              <button type="button" className={secondaryActionClass} onClick={() => continueRun(run)}>
                                继续
                              </button>
                            )}
                            {canStart && (
                              <button
                                type="button"
                                className={secondaryActionClass}
                                disabled={startingId === task.id}
                                onClick={() => void startTask(task)}
                              >
                                <Play size={12} aria-hidden="true" />
                                {startingId === task.id ? "准备中…" : run ? "重试" : "开始"}
                              </button>
                            )}
                            {canRevise && task.status === "completed" && (
                              <button
                                type="button"
                                className={secondaryActionClass}
                                onClick={() => setReviewTask(task)}
                              >
                                再来一版
                              </button>
                            )}
                            {task.status === "pending_review" && run && (
                              <button
                                type="button"
                                className={primaryActionClass}
                                onClick={() => setReviewTask(task)}
                              >
                                {reviewCopy.cardAction}
                              </button>
                            )}
                            <button
                              type="button"
                              className={ghostActionClass}
                              disabled={deletingId === task.id || task.status === "running"}
                              title={
                                task.status === "running"
                                  ? "先停掉正在跑的 Agent，再删"
                                  : "删除这个目标"
                              }
                              onClick={() => void deleteGoal(task)}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              {deletingId === task.id ? "删除中…" : "删除"}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4">
          <ProjectRulesPanel
            projectPath={project.path}
            workMode={project.workMode}
            compact
            onError={setError}
          />
        </div>
      </section>
      {withSessions && sessionsOpen && (
        <aside
          className={`${sessionsAsideOpenClass} ccode-project-sessions-rail ${
            sessionsOpen ? "ccode-project-sessions-rail-open" : ""
          }`}
        >
          <div className="flex min-w-0 flex-col gap-4">
            <ProjectSessionsSection
              projectPath={project.path}
              variant="sidebar"
              collapsed={false}
              onToggle={() => setSessionsOpen(false)}
              title="这个项目的对话"
              onNewChat={(event) =>
                beginProjectChat(
                  {
                    cwd: project.path,
                    name: project.name,
                    kind: "office",
                    preferredAgent: project.defaultAgent,
                    preferredProfile: project.defaultAgent
                      ? project.defaultProfiles?.[project.defaultAgent]
                      : undefined,
                  },
                  { forcePick: !!(event.metaKey || event.ctrlKey) },
                )
              }
              empty={
                <button
                  type="button"
                  className={`${compactPrimaryActionClass} w-full`}
                  onClick={(event) =>
                    beginProjectChat(
                      {
                        cwd: project.path,
                        name: project.name,
                        kind: "office",
                        preferredAgent: project.defaultAgent,
                        preferredProfile: project.defaultAgent
                          ? project.defaultProfiles?.[project.defaultAgent]
                          : undefined,
                      },
                      { forcePick: !!(event.metaKey || event.ctrlKey) },
                    )
                  }
                >
                  ＋ 发起新对话
                </button>
              }
            />
            <ScheduleSection projectRoot={project.path} steps={[]} layout="card" />
          </div>
        </aside>
      )}
    </div>
      {createOpen && (
        <CreateTaskModal
          project={project}
          profiles={visibleProfiles}
          onClose={() => setCreateOpen(false)}
          onCreated={async (task, start) => {
            setCreateOpen(false);
            await load();
            if (start) await startTask(task);
          }}
          onError={setError}
        />
      )}
      {reviewTask && (
        <ReviewOutputsModal
          workMode={project.workMode}
          task={tasks.find((task) => task.id === reviewTask.id) ?? reviewTask}
          run={latestRunByTask.get(reviewTask.id) ?? null}
          runCount={
            runs.filter((item) => item.taskId === reviewTask.id && !item.internal).length
          }
          previousFeedback={parseReviewNote(
            events.filter(
              (event) =>
                event.eventType === "task.review_notes" &&
                runs.some(
                  (item) => item.id === event.runId && item.taskId === reviewTask.id,
                ),
            ).slice(-1)[0]?.payload,
          )}
          onClose={() => setReviewTask(null)}
          onAdopted={() => {
            setReviewTask(null);
            void load();
          }}
          onContinue={async (feedback) => {
            const current = tasks.find((item) => item.id === reviewTask.id) ?? reviewTask;
            setReviewTask(null);
            await startTask(current, { reuseIsolation: true, feedback });
          }}
          onError={setError}
        />
      )}
    </>
  );
}

const MATERIAL_SCOPES: { id: TaskMaterialScope; label: string }[] = [
  { id: "whole", label: "整个项目" },
  { id: "selected", label: "指定资料" },
  { id: "none", label: "不带入" },
];

function CreateTaskModal({
  project,
  profiles,
  onClose,
  onCreated,
  onError,
}: {
  project: ProjectDto;
  profiles: ReturnType<typeof useAppStore.getState>["profiles"];
  onClose: () => void;
  onCreated: (task: TaskDto, start: boolean) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permission, setPermission] = useState<TaskPermission>("write_tree");
  const [scope, setScope] = useState<TaskMaterialScope>("whole");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const configuredAgents = AGENTS.filter((agent) =>
    profiles.some((profile) => profile.agent === agent.id),
  );
  const [taskAgent, setTaskAgent] = useState(
    project.defaultAgent ?? configuredAgents[0]?.id ?? "",
  );
  const detectedAgents = useAppStore((s) => s.agents);
  const discussUnsupported = permission === "discuss" && !detectedAgents.find((a) => a.id === taskAgent)?.readonlySupported;
  const agentProfiles = profiles.filter((profile) => profile.agent === taskAgent);
  const [taskProfile, setTaskProfile] = useState(
    project.defaultProfiles?.[taskAgent] ?? agentProfiles[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const setPage = useAppStore((s) => s.setPage);
  useEffect(() => {
    if (!taskAgent && configuredAgents[0]) setTaskAgent(configuredAgents[0].id);
  }, [configuredAgents, taskAgent]);
  useEffect(() => {
    if (!agentProfiles.some((profile) => profile.id === taskProfile)) {
      setTaskProfile(project.defaultProfiles?.[taskAgent] ?? agentProfiles[0]?.id ?? "");
    }
  }, [agentProfiles, project.defaultProfiles, taskAgent, taskProfile]);

  const copy = goalReviewCopy(project.workMode);
  const canSave = canSaveDeclaredGoal({
    name,
    scope,
    selectedPaths,
    permission,
  });
  const canSubmit = canSubmitDeclaredTask({
    name,
    scope,
    selectedPaths,
    profileId: taskProfile,
    permission,
  });

  async function createGoal(start: boolean) {
    const paths = taskPathsForScope(scope, selectedPaths, permission);
    if (paths.error) {
      setFormError(paths.error);
      return;
    }
    if (start && discussUnsupported) { setFormError("所选 Agent 不支持只读/计划模式，请更换 Agent 或明确选择可写权限。"); return; }
    if (start && !taskProfile) {
      setFormError("开始前请选择 Agent 和配置。");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const task = await invoke<TaskDto>("task_create", {
        input: {
          projectRoot: project.path,
          kind: project.workMode === "office" ? "office_doc" : "free_research",
          name,
          description,
          inputPaths: paths.inputPaths,
          outputPaths: paths.outputPaths,
          permission,
          agent: taskAgent || null,
          profileId: taskProfile || null,
        },
      });
      await onCreated(task, start);
    } catch (reason) {
      const message = `创建任务失败：${String(reason)}`;
      setFormError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await createGoal(true);
  }

  return (
    <Modal open title="新建目标" onClose={onClose} size={moreOpen ? "lg" : "md"}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-l3">
          要完成什么
          <textarea
            className="mt-1 min-h-20 w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDescription(event.target.value);
            }}
            placeholder={
              project.workMode === "office"
                ? "例如：按公司模板写本周周报，保存到文档/周报.md"
                : "例如：根据项目里的文献，写一篇综述并保存到论文/综述.md"
            }
            required
            autoFocus
          />
        </label>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
        >
          <FoldMark open={moreOpen} />
          资料和 Agent
        </button>
        {moreOpen && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-l3">资料</p>
              <SegTabs items={MATERIAL_SCOPES} value={scope} onChange={setScope} />
              {scope === "selected" && (
                <TaskMaterialsPicker
                  projectPath={project.path}
                  selected={selectedPaths}
                  onChange={setSelectedPaths}
                />
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-l3">权限</p>
              {discussUnsupported && <p className="mb-2 text-xs text-warn-text">所选 Agent 不支持只读/计划模式，不能以“只讨论”启动。</p>}
              <SegTabs
                items={[
                  { id: "write_tree" as const, label: copy.writeTab },
                  { id: "discuss" as const, label: "只讨论" },
                ]}
                value={permission}
                onChange={setPermission}
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-l3">Agent</p>
              {configuredAgents.length === 0 ? (
                <p className="text-xs text-l4">
                  还没有可用连接。
                  <button
                    type="button"
                    className="ml-1 text-l2 hover:text-l1 hover:underline"
                    onClick={() => {
                      onClose();
                      setPage("profiles");
                    }}
                  >
                    去连接页
                  </button>
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {configuredAgents.map((agent) => {
                    const on = taskAgent === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs ${
                          on ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                        }`}
                        onClick={() => setTaskAgent(agent.id)}
                      >
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: agentBrand(agent.id) }}
                        />
                        {agent.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {configuredAgents.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-l3">连接</p>
                {agentProfiles.length === 0 ? (
                  <p className="text-xs text-l4">
                    这家还没有连接。
                    <button
                      type="button"
                      className="ml-1 text-l2 hover:text-l1 hover:underline"
                      onClick={() => {
                        onClose();
                        setPage("profiles");
                      }}
                    >
                      去连接页
                    </button>
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {agentProfiles.map((profile) => {
                      const on = taskProfile === profile.id;
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          className={`inline-flex h-7 items-center rounded-full px-2.5 text-xs ${
                            on ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                          }`}
                          onClick={() => setTaskProfile(profile.id)}
                        >
                          {profile.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {formError && <p className="text-xs text-err-text">{formError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={secondaryActionClass}
            disabled={busy || !canSave}
            onClick={() => void createGoal(false)}
          >
            {busy ? "记下…" : "记下"}
          </button>
          <button
            type="submit"
            className={primaryActionClass}
            disabled={busy || !canSubmit}
          >
            {busy ? "正在准备…" : "开始"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskMaterialsPicker({
  projectPath,
  selected,
  onChange,
}: {
  projectPath: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [cache, setCache] = useState<Record<string, DirEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([projectPath]));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", {
          path,
          showHidden: false,
        });
        setCache((current) => ({
          ...current,
          [path]: entries.filter((entry) => !isTaskMaterialNoise(entry.name, entry.isSystem)),
        }));
        setError(null);
      } catch (reason) {
        setError(`读取项目文件失败：${String(reason)}`);
      }
    },
    [],
  );

  useEffect(() => {
    setCache({});
    setExpanded(new Set([projectPath]));
    void load(projectPath);
  }, [load, projectPath]);

  async function toggleDir(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!cache[path]) await load(path);
    }
    setExpanded(next);
  }

  function toggleRelative(relative: string, checked: boolean) {
    onChange(toggleTaskMaterialPath(selected, relative, checked));
  }

  function renderEntries(root: string, depth: number): ReactNode {
    return (cache[root] ?? []).map((entry) => {
      const relative = relativeProjectPath(projectPath, entry.path);
      if (!relative) return null;
      const implied = pathCoveredBySelection(relative, selected) && !selected.includes(relative);
      const checked = selected.includes(relative) || implied;
      const open = expanded.has(entry.path);
      return (
        <li key={entry.path}>
          <div
            className="flex min-h-8 items-center gap-1.5 rounded-md px-1 hover:bg-hover"
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <Checkbox
              checked={checked}
              disabled={implied}
              onChange={(next) => toggleRelative(relative, next)}
            />
            {entry.isDir ? (
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs text-l2"
                onClick={() => void toggleDir(entry.path)}
                aria-expanded={open}
              >
                <FoldMark open={open} />
                <span className="truncate">{entry.name}</span>
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-l2">
                <FileTypeMark path={entry.path} />
                <span className="truncate">{entry.name}</span>
              </span>
            )}
          </div>
          {entry.isDir && open && <ul>{renderEntries(entry.path, depth + 1)}</ul>}
        </li>
      );
    });
  }

  return (
    <div className="mt-2">
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {selected.map((path) => (
            <button
              key={path}
              type="button"
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-micro text-l2 hover:bg-inset"
              onClick={() => toggleRelative(path, false)}
              title="移出这一步"
            >
              <span className="truncate">{path}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="mb-1 text-micro text-err-text">{error}</p>}
      <div className="max-h-56 overflow-auto rounded-md border border-hairline bg-canvas py-1">
        {cache[projectPath] ? (
          <ul>{renderEntries(projectPath, 0)}</ul>
        ) : (
          <p className="px-2 py-2 text-micro text-l4">读取项目文件…</p>
        )}
      </div>
    </div>
  );
}

function ReviewOutputsModal({
  workMode,
  task,
  run,
  runCount,
  previousFeedback,
  onClose,
  onAdopted,
  onContinue,
  onError,
}: {
  workMode?: string | null;
  task: TaskDto;
  run: RunDto | null;
  runCount: number;
  previousFeedback?: string | null;
  onClose: () => void;
  onAdopted: () => void;
  onContinue: (feedback: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const copy = goalReviewCopy(workMode);
  const [changes, setChanges] = useState<TaskOutputChangeDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [protectedPaths, setProtectedPaths] = useState<string[]>([]);
  const [frozen, setFrozen] = useState(true);
  const [payloadDir, setPayloadDir] = useState<string | null>(null);
  const [reviewSeq, setReviewSeq] = useState<number | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<TaskContextDto | null>(null);
  // 勾选只初始化一次：之后任何刷新（含 protectedPaths 晚到触发的重拉）都合并而不是重置，
  // 用户取消的勾选不能被抹掉；初始化后才出现的新变更不自动勾上（人还没看过）
  const selectionReadyRef = useRef(false);
  useEffect(() => {
    selectionReadyRef.current = false;
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    let stale = false;
    invoke<TaskContextDto | null>("task_run_context", { runId: run.id })
      .then((value) => {
        if (!stale) setContextSnapshot(value);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [run]);

  useEffect(() => {
    if (!previewPath) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPreviewPath(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [previewPath]);

  useEffect(() => {
    if (!task.projectRoot) {
      setProtectedPaths([]);
      return;
    }
    let stale = false;
    invoke<{ config: { protectedPaths?: string[] } }>("read_project_config", {
      path: task.projectRoot,
    })
      .then((read) => {
        if (!stale) setProtectedPaths(read.config.protectedPaths ?? []);
      })
      .catch(() => {
        if (!stale) setProtectedPaths([]);
      });
    return () => {
      stale = true;
    };
  }, [task.projectRoot]);

  useEffect(() => {
    if (!run) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    invoke<TaskReviewDto>("task_output_changes", { runId: run.id })
      .then((review) => {
        if (stale) return;
        setFrozen(review.frozen);
        setPayloadDir(review.payloadDir);
        setReviewSeq(review.seq ?? null);
        setChanges(review.changes);
        setSelected((prev) => {
          const next = new Set(prev);
          for (const row of review.changes) {
            if (row.kind === "deleted" || pathIsProtected(row.path, protectedPaths)) {
              next.delete(row.path);
            } else if (!selectionReadyRef.current) {
              next.add(row.path);
            }
          }
          selectionReadyRef.current = true;
          return next;
        });
      })
      .catch((reason) => {
        if (!stale) onError(`读取变更失败：${String(reason)}`);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [onError, protectedPaths, run]);

  async function adopt() {
    if (!run) return;
    setBusy(true);
    try {
      await invoke("task_adopt_outputs", {
        runId: run.id,
        paths: selectedChangePaths(changes, selected).filter(
          (path) => !pathIsProtected(path, protectedPaths),
        ),
        note: feedback.trim() || null,
        expectSeq: reviewSeq,
      });
      onAdopted();
    } catch (reason) {
      onError(`采纳输出失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  const selectable = changes.filter(
    (change) => change.kind !== "deleted" && !pathIsProtected(change.path, protectedPaths),
  );
  const selectedCount = selected.size;
  const previewBase = payloadDir ?? run?.isolationPath ?? null;
  const previewAbs = previewPath && previewBase ? joinRunPath(previewBase, previewPath) : null;
  const groups = groupReviewChanges(workMode, changes);
  const previewIndex = previewPath
    ? changes.findIndex((change) => change.path === previewPath)
    : -1;

  return (
    <>
    <Modal open title={`${copy.modalTitle} · ${task.name}`} onClose={onClose} size="md">
      <div className="space-y-3 text-xs">
        <ul className="space-y-0.5 text-l3">
          {goalReviewFacts({
            workMode,
            agentLabel: agentLabel(run?.agent ?? task.agent ?? ""),
            runCount,
            changes,
            feedback: previousFeedback,
          }).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {!loading && run && run.status !== "completed" && (
          <p className="ccode-well rounded-md px-2 py-1.5 text-micro text-l3">
            这次运行未正常完成（{run.status === "stopped" ? "已停止" : "失败"}）：
            下面是它留下的部分成果，已在收尾时冻结。请确认过程没有半途而废，再决定采纳还是写意见再出一版。
          </p>
        )}
        {!loading && !frozen && (
          <p className="ccode-well rounded-md px-2 py-1.5 text-micro text-l3">
            这版结果没有冻结证据（旧版本生成或收尾时冻结失败）：下面按目录当前内容现算，
            如果项目在这期间被你改过，采纳不会逐文件提醒，请先自行核对。
          </p>
        )}
        {contextSnapshot && (
          <details className="rounded-md border border-field px-2 py-1.5 text-micro text-l3">
            <summary className="cursor-pointer select-none">
              本次工作环境（开工时冻结，可核对这版成果基于什么材料）
            </summary>
            <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap text-l4">
              {contextSnapshot.text}
            </pre>
          </details>
        )}
        {loading ? (
          <p className="text-l4">读取这版的变更…</p>
        ) : changes.length === 0 ? (
          <p className="text-l3">{copy.empty}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-l2">
                <span className="font-medium">{copy.pickLabel}</span>
                <span className="ml-1.5 font-normal text-l4">{copy.hint}</span>
              </p>
              <button
                type="button"
                className={rowActionClass}
                onClick={() =>
                  setSelected(
                    selectedCount === selectable.length
                      ? new Set()
                      : new Set(selectable.map((change) => change.path)),
                  )
                }
              >
                {selectedCount === selectable.length ? "全不选" : "全选"}
              </button>
            </div>
            <div className="max-h-72 space-y-3 overflow-auto">
              {groups.map((group) => (
                <div key={group.id}>
                  <p className="mb-1 text-micro font-medium text-l4">
                    {group.label}
                    <span className="ml-1 font-normal">{group.items.length}</span>
                  </p>
                  <ul className="space-y-1">
                    {group.items.map((change) => (
                      <li key={change.path} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                        <Checkbox
                          checked={selected.has(change.path)}
                          disabled={
                            change.kind === "deleted" ||
                            pathIsProtected(change.path, protectedPaths)
                          }
                          onChange={(checked) => {
                            if (pathIsProtected(change.path, protectedPaths)) return;
                            const next = new Set(selected);
                            if (checked) next.add(change.path);
                            else next.delete(change.path);
                            setSelected(next);
                          }}
                        />
                        <FileTypeMark path={change.path} />
                        {change.kind === "deleted" ? (
                          <span
                            className="min-w-0 flex-1 truncate text-l3 line-through"
                            title={change.path}
                          >
                            {change.path}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-l2 hover:underline"
                            onClick={() => setPreviewPath(change.path)}
                            title={change.path}
                          >
                            {change.path}
                          </button>
                        )}
                        <span className="shrink-0 text-micro text-l4">
                          {change.kind === "deleted"
                            ? taskChangeKindLabel(change.kind)
                            : pathIsProtected(change.path, protectedPaths)
                              ? "保持原样"
                              : taskChangeKindLabel(change.kind)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
        <label className="block text-xs text-l2">
          <span className="font-medium">意见</span>
          <span className="ml-1.5 font-normal text-l4">不满意再出一版</span>
          <textarea
            className="mt-1 min-h-16 w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder={copy.continuePlaceholder}
          />
        </label>
        {selectedCount > 0 && (
          <p className="text-micro text-l4">{copy.rememberLine}</p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            稍后
          </button>
          <button
            type="button"
            className={secondaryActionClass}
            disabled={busy || loading || !run || !feedback.trim()}
            onClick={() => void onContinue(feedback.trim())}
          >
            {copy.continueLabel}
          </button>
          {task.status !== "completed" && (
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy || loading || !run}
            onClick={() => void adopt()}
          >
            {busy
              ? "写入中…"
              : changes.length === 0 || selectedCount === 0
                ? copy.acceptEmpty
                : copy.acceptSome(selectedCount)}
          </button>
          )}
        </div>
      </div>
    </Modal>
      {previewAbs && previewBase && run && (
        <OfficePreviewModal
          path={previewAbs}
          root={previewBase}
          onClose={() => setPreviewPath(null)}
          hasPrevious={previewIndex > 0}
          hasNext={previewIndex >= 0 && previewIndex < changes.length - 1}
          onPrevious={() => {
            if (previewIndex > 0) setPreviewPath(changes[previewIndex - 1].path);
          }}
          onNext={() => {
            if (previewIndex >= 0 && previewIndex < changes.length - 1) {
              setPreviewPath(changes[previewIndex + 1].path);
            }
          }}
        />
      )}
    </>
  );
}
