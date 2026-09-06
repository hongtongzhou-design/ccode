import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Plus, RotateCw } from "lucide-react";
import { runInboxAction, useAppStore } from "../store";
import {
  AGENTS,
  type ProjectDto,
  type RunDto,
  type TaskDto,
  type TaskOutputChangeDto,
} from "../types";
import {
  Checkbox,
  compactPrimaryActionClass,
  fieldClass,
  FoldMark,
  primaryActionClass,
  projectWellClass,
  rowActionClass,
  secondaryActionClass,
  SegTabs,
} from "./PageFrame";
import { Modal } from "./Modal";
import { projectTaskLabel } from "../project-surface";
import ProjectSessionsSection, {
  sessionsAsideOpenClass,
} from "./ProjectSessionsSection";
import ScheduleSection from "./ScheduleSection";
import { beginProjectChat } from "./AskAiModal";
import {
  canSubmitDeclaredTask,
  declaredTaskKindsForMode,
  isTaskMaterialNoise,
  joinRunPath,
  pathCoveredBySelection,
  relativeProjectPath,
  selectedChangePaths,
  taskChangeKindLabel,
  taskInputLabel,
  taskOutputLabel,
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
import { composeLaunchPrompt } from "../project-context";
import { loadProjectContextPack } from "../project-context-load";

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
}: {
  project: ProjectDto;
  /** 嵌进无流程科研左栏：不重复项目名、不另开对话栏。 */
  embed?: boolean;
}) {
  const profiles = useAppStore((state) => state.profiles);
  const hiddenProfiles = useAppStore((state) => state.settings?.hiddenProfiles ?? []);
  const setPage = useAppStore((state) => state.setPage);
  const setPendingTerminal = useAppStore((state) => state.setPendingTerminal);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTask, setReviewTask] = useState<TaskDto | null>(null);
  const taskReviewReq = useAppStore((state) => state.taskReviewReq);
  const setTaskReviewReq = useAppStore((state) => state.setTaskReviewReq);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
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
      const [nextTasks, nextRuns] = await Promise.all([
        invoke<TaskDto[]>("task_list", { projectRoot: project.path }),
        invoke<RunDto[]>("run_list", { projectRoot: project.path }),
      ]);
      setTasks(visibleDeclaredTasks(nextTasks, declaredTaskKindsForMode(project.workMode)));
      setRuns(nextRuns);
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

  async function startTask(task: TaskDto) {
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
      const run = await invoke<RunDto>("task_prepare_run", {
        input: {
          taskId: task.id,
          agent: profile.agent,
          profileId: profile.id,
        },
      });
      const pack = await loadProjectContextPack({
        name: project.name,
        path: project.path,
        workMode: project.workMode,
        goal: task.description || task.name,
        writeReview: task.reviewRequired,
      });
      setPendingTerminal({
        cwd: run.isolationPath,
        extraEnv: {},
        title: task.name,
        agentId: profile.agent,
        profileId: profile.id,
        model: profile.models[0] ?? "",
        autoStart: true,
        permission: task.reviewRequired ? "write_tree" : "discuss",
        initialPrompt: composeLaunchPrompt(
          pack,
          task.description?.trim() || task.name,
        ),
        reuseKey: `task:${task.id}`,
        runId: run.id,
        taskId: task.id,
      });
      setPage("terminal");
    } catch (reason) {
      setError(`启动任务失败：${String(reason)}`);
    } finally {
      setStartingId(null);
      void load();
    }
  }

  return (
    <>
    <div className="mb-4 flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-0">
      <section className={`min-w-0 flex-1 ${projectWellClass} ${withSessions && sessionsOpen ? "lg:pr-6" : ""}`}>
        <div className="mb-3 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-l1">
              {embed ? "任务" : projectTaskLabel(project.workMode)}
            </h2>
            <p className="mt-1 text-xs text-l4">
              说要完成什么。默认在项目副本里做，你验收后再写回。
            </p>
          </div>
          {withSessions && !sessionsOpen && (
            <div className="shrink-0">
              <ProjectSessionsSection
                projectPath={project.path}
                variant="sidebar"
                collapsed
                onToggle={() => setSessionsOpen(true)}
                title="项目对话"
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
        {tasks.length === 0 ? (
          <p className="px-1 py-2 text-xs text-l4">还没有目标。说一句要完成什么即可。</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => {
              const run = latestRunByTask.get(task.id);
              const running = task.status === "running";
              const canStart = !run || ["failed", "stopped"].includes(task.status);
              return (
                <li key={task.id} className="rounded-md bg-raised/45 px-3 py-2">
                  <div className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-l1">{task.name}</span>
                        <span className="rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                          {taskStatusLabel(task.status)}
                        </span>
                      </span>
                      {task.description && (
                        <span className="mt-1 block text-xs text-l3">{task.description}</span>
                      )}
                      <span className="mt-1 block text-micro text-l4">
                        {agentLabel(task.agent ?? run?.agent ?? project.defaultAgent ?? "") || "跟随项目默认"}
                        {" · "}
                        {taskInputLabel(task.inputPaths)}
                        {" · "}
                        {taskOutputLabel(task.outputPaths, task.reviewRequired)}
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
                    {task.status === "pending_review" && run && (
                      <button
                        type="button"
                        className={primaryActionClass}
                        onClick={() => setReviewTask(task)}
                      >
                        验收
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {withSessions && sessionsOpen && (
        <aside className={sessionsAsideOpenClass}>
          <div className="flex min-w-0 flex-col gap-4">
            <ProjectSessionsSection
              projectPath={project.path}
              variant="sidebar"
              collapsed={false}
              onToggle={() => setSessionsOpen(false)}
              title="项目对话"
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
          onCreated={async (task) => {
            setCreateOpen(false);
            await load();
            await startTask(task);
          }}
          onError={setError}
        />
      )}
      {reviewTask && (
        <ReviewOutputsModal
          task={tasks.find((task) => task.id === reviewTask.id) ?? reviewTask}
          run={latestRunByTask.get(reviewTask.id) ?? null}
          onClose={() => setReviewTask(null)}
          onAdopted={() => {
            setReviewTask(null);
            void load();
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

function materialHint(scope: TaskMaterialScope, permission: TaskPermission): string {
  if (scope === "none") {
    return permission === "write_tree"
      ? "空副本里写。验收通过后，新文件才进项目。"
      : "不带项目文件，只讨论。";
  }
  if (scope === "whole") {
    return "复制整个项目（不含 .git / .ccode）。不同步骤仍应尽量缩小范围。";
  }
  return "Agent 只能看到勾选的文件或目录。另一步可以勾另一批资料、换另一个 Agent。";
}

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
  onCreated: (task: TaskDto) => Promise<void>;
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
  const agentProfiles = profiles.filter((profile) => profile.agent === taskAgent);
  const [taskProfile, setTaskProfile] = useState(
    project.defaultProfiles?.[taskAgent] ?? agentProfiles[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    if (!taskAgent && configuredAgents[0]) setTaskAgent(configuredAgents[0].id);
  }, [configuredAgents, taskAgent]);
  useEffect(() => {
    if (!agentProfiles.some((profile) => profile.id === taskProfile)) {
      setTaskProfile(project.defaultProfiles?.[taskAgent] ?? agentProfiles[0]?.id ?? "");
    }
  }, [agentProfiles, project.defaultProfiles, taskAgent, taskProfile]);

  const canSubmit = canSubmitDeclaredTask({
    name,
    scope,
    selectedPaths,
    profileId: taskProfile,
    permission,
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const paths = taskPathsForScope(scope, selectedPaths, permission);
    if (paths.error) {
      setFormError(paths.error);
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
      await onCreated(task);
    } catch (reason) {
      const message = `创建任务失败：${String(reason)}`;
      setFormError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="新建目标" onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-l3">
          说要完成什么。怎么做由 Agent 自己决定；改动验收后才进项目。
        </p>
        <label className="block text-xs text-l3">
          要完成什么
          <textarea
            className="mt-1 min-h-20 w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l1 outline-none placeholder:text-l4 focus:border-l4"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDescription(event.target.value);
            }}
            placeholder="例如：根据项目里的文献，写一篇综述并保存到论文/综述.md"
            required
            autoFocus
          />
        </label>
        <div>
          <p className="mb-1 text-xs text-l3">资料</p>
          <SegTabs items={MATERIAL_SCOPES} value={scope} onChange={setScope} />
          <p className="mt-1.5 text-micro text-l4">{materialHint(scope, permission)}</p>
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
          <SegTabs
            items={[
              { id: "write_tree" as const, label: "写入并验收" },
              { id: "discuss" as const, label: "只讨论" },
            ]}
            value={permission}
            onChange={setPermission}
          />
          <p className="mt-1.5 text-micro text-l4">
            {permission === "write_tree"
              ? "改动只发生在独立副本。你勾选后才写回项目，已有文件不会被悄悄覆盖。"
              : "只讨论，不改项目文件。"}
          </p>
        </div>
        <label className="block text-xs text-l3">
          Agent
          <select
            className={`${fieldClass} mt-1 text-l1`}
            value={taskAgent}
            onChange={(event) => setTaskAgent(event.target.value)}
          >
            {configuredAgents.length === 0 ? (
              <option value="">先到连接页配置 Agent</option>
            ) : (
              configuredAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                  {agent.id === project.defaultAgent ? "（项目默认）" : ""}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="block text-xs text-l3">
          配置
          <select
            className={`${fieldClass} mt-1 text-l1`}
            value={taskProfile}
            onChange={(event) => setTaskProfile(event.target.value)}
            disabled={agentProfiles.length === 0}
          >
            {agentProfiles.length === 0 ? (
              <option value="">先配置连接</option>
            ) : (
              agentProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                  {profile.id === project.defaultProfiles?.[taskAgent] ? "（项目默认）" : ""}
                </option>
              ))
            )}
          </select>
        </label>
        {formError && <p className="text-xs text-err-text">{formError}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className={primaryActionClass}
            disabled={busy || !canSubmit}
          >
            {busy ? "正在准备…" : "开始这一步"}
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
  task,
  run,
  onClose,
  onAdopted,
  onError,
}: {
  task: TaskDto;
  run: RunDto | null;
  onClose: () => void;
  onAdopted: () => void;
  onError: (message: string) => void;
}) {
  const [changes, setChanges] = useState<TaskOutputChangeDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

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
    if (!run) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    invoke<TaskOutputChangeDto[]>("task_output_changes", { runId: run.id })
      .then((rows) => {
        if (stale) return;
        setChanges(rows);
        setSelected(new Set(rows.map((row) => row.path)));
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
  }, [onError, run]);

  async function adopt() {
    if (!run) return;
    setBusy(true);
    try {
      await invoke("task_adopt_outputs", {
        runId: run.id,
        paths: selectedChangePaths(changes, selected),
      });
      onAdopted();
    } catch (reason) {
      onError(`采纳输出失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = selected.size;
  const previewAbs = previewPath && run ? joinRunPath(run.isolationPath, previewPath) : null;

  return (
    <>
    <Modal open title={`验收 · ${task.name}`} onClose={onClose} size="md">
      <div className="space-y-3 text-xs">
        {loading ? (
          <p className="text-l4">比较独立副本与项目…</p>
        ) : changes.length === 0 ? (
          <p className="text-l3">没有新增或修改的文件。可以直接完成任务，项目不会被改写。</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-l4">勾选要带回项目的文件。未勾选的留在独立副本，删除不会同步。</p>
              <button
                type="button"
                className={rowActionClass}
                onClick={() =>
                  setSelected(
                    selectedCount === changes.length
                      ? new Set()
                      : new Set(changes.map((change) => change.path)),
                  )
                }
              >
                {selectedCount === changes.length ? "全不选" : "全选"}
              </button>
            </div>
            <ul className="max-h-72 space-y-1 overflow-auto">
              {changes.map((change) => (
                <li key={change.path} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                  <Checkbox
                    checked={selected.has(change.path)}
                    onChange={(checked) => {
                      const next = new Set(selected);
                      if (checked) next.add(change.path);
                      else next.delete(change.path);
                      setSelected(next);
                    }}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-l2 hover:underline"
                    onClick={() => setPreviewPath(change.path)}
                    title={change.path}
                  >
                    {change.path}
                  </button>
                  <span className="shrink-0 text-micro text-l4">
                    {taskChangeKindLabel(change.kind)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={rowActionClass} onClick={onClose}>
            稍后
          </button>
          <button
            type="button"
            className={primaryActionClass}
            disabled={busy || loading || !run}
            onClick={() => void adopt()}
          >
            {busy
              ? "写入中…"
              : changes.length === 0 || selectedCount === 0
                ? "不带回文件，完成任务"
                : `采纳 ${selectedCount} 个文件`}
          </button>
        </div>
      </div>
    </Modal>
      {previewAbs && run && (
        <OfficePreviewModal
          path={previewAbs}
          root={run.isolationPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  );
}
