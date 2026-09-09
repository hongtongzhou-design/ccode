import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import { useAppStore } from "../store";
import { AGENTS, type ProjectDto, type TaskDto } from "../types";
import {
  ghostActionClass,
  hoverRevealClass,
  projectWellClass,
  secondaryActionClass,
} from "./PageFrame";
import { agentBrand } from "../agent-colors";
import {
  buildProjectAgentRoster,
  currentProfileLine,
  projectAgentsEmptyWorkHint,
  projectAgentsHint,
  type ProjectAgentRow,
} from "../project-agents";
import { declaredTaskKindsForMode } from "../project-tasks";

export default function ProjectAgentsView({
  project,
  onProjectChanged,
  onOpenGoals,
  onError,
}: {
  project: ProjectDto;
  onProjectChanged: (project: ProjectDto) => void;
  onOpenGoals?: () => void;
  onError: (message: string) => void;
}) {
  const profiles = useAppStore((state) => state.profiles);
  const hiddenProfiles = useAppStore((state) => state.settings?.hiddenProfiles ?? []);
  const setPage = useAppStore((state) => state.setPage);
  const [saving, setSaving] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState(project.defaultAgent ?? "");
  const [defaultProfiles, setDefaultProfiles] = useState<Record<string, string>>(
    project.defaultProfiles ?? {},
  );
  const [tasks, setTasks] = useState<TaskDto[]>([]);

  useEffect(() => {
    setDefaultAgent(project.defaultAgent ?? "");
    setDefaultProfiles(project.defaultProfiles ?? {});
  }, [project.defaultAgent, project.defaultProfiles]);

  const taskKinds = useMemo(
    () => declaredTaskKindsForMode(project.workMode),
    [project.workMode],
  );

  const loadTasks = useCallback(async () => {
    if (taskKinds.size === 0) {
      setTasks([]);
      return;
    }
    try {
      const next = await invoke<TaskDto[]>("task_list", { projectRoot: project.path });
      setTasks(next);
    } catch (reason) {
      onError(`读取目标失败：${String(reason)}`);
    }
  }, [onError, project.path, taskKinds]);

  useEffect(() => {
    void loadTasks();
    if (taskKinds.size === 0) return;
    const timer = window.setInterval(() => void loadTasks(), 2500);
    return () => window.clearInterval(timer);
  }, [loadTasks, taskKinds]);

  const roster = useMemo(
    () =>
      buildProjectAgentRoster({
        catalog: AGENTS,
        profiles,
        hiddenProfileIds: hiddenProfiles,
        defaultAgent,
        defaultProfiles,
        tasks,
        taskKinds,
        workMode: project.workMode,
      }),
    [defaultAgent, defaultProfiles, hiddenProfiles, profiles, project.workMode, taskKinds, tasks],
  );

  async function saveAgent(agent: string) {
    setSaving(true);
    try {
      await invoke("set_project_default_agent", {
        projectRoot: project.path,
        agent: agent || null,
      });
      setDefaultAgent(agent);
      onProjectChanged({
        ...project,
        defaultAgent: agent || null,
        defaultProfiles,
      });
    } catch (reason) {
      onError(`保存项目默认 Agent 失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile(agent: string, profileId: string) {
    if (!agent) return;
    setSaving(true);
    const next = { ...defaultProfiles };
    if (profileId) next[agent] = profileId;
    else delete next[agent];
    try {
      await invoke("set_project_default_profile", {
        projectRoot: project.path,
        agent,
        profileId: profileId || null,
      });
      setDefaultProfiles(next);
      onProjectChanged({
        ...project,
        defaultAgent: defaultAgent || null,
        defaultProfiles: next,
      });
    } catch (reason) {
      onError(`保存默认配置失败：${String(reason)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={projectWellClass}>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-l1">Agents</h2>
        <p className="min-w-0 flex-1 truncate text-xs text-l4">
          {projectAgentsHint(project.workMode)}
        </p>
        <button
          type="button"
          className={secondaryActionClass}
          onClick={() => setPage("profiles")}
        >
          连接
        </button>
      </div>
      {roster.rows.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-l4">
          还没有可用连接。
          <button
            type="button"
            className="ml-1 text-l2 underline-offset-2 hover:text-l1 hover:underline"
            onClick={() => setPage("profiles")}
          >
            去连接页
          </button>
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {roster.rows.map((row) => (
            <li
              key={row.agentId}
              className={`group relative rounded-lg px-3 py-3 ${
                row.isProjectDefault ? "bg-hover" : "hover:bg-hover"
              }`}
            >
              {row.isProjectDefault && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-3 left-0 top-3 w-0.5 rounded-full"
                  style={{ background: agentBrand(row.agentId) }}
                />
              )}
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: agentBrand(row.agentId) }}
                />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">
                  {row.label}
                </h3>
                {row.isProjectDefault ? (
                  <button
                    type="button"
                    className={`${ghostActionClass} text-micro`}
                    disabled={saving}
                    title="取消后，＋新对话不再默认用这家。不改 Mesa 启动栏，也不写 CLI 全局文件。"
                    onClick={() => void saveAgent("")}
                  >
                    项目默认
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${ghostActionClass} ${hoverRevealClass} text-micro`}
                    disabled={saving}
                    title="只影响这个项目的新对话预选，不改 Mesa 启动栏，也不写 CLI 全局文件"
                    onClick={() => void saveAgent(row.agentId)}
                  >
                    设为项目默认
                  </button>
                )}
              </div>
              <div className="mt-1 pl-[18px]">
                {row.profiles.length === 0 ? (
                  <button
                    type="button"
                    className="text-xs text-l4 hover:text-l2"
                    onClick={() => setPage("profiles")}
                  >
                    还没有连接
                  </button>
                ) : (
                  <ProfileMenu
                    row={row}
                    disabled={saving}
                    onPick={(profileId) => void saveProfile(row.agentId, profileId)}
                    onAdd={() => setPage("profiles")}
                  />
                )}
              </div>
              {row.works.length > 0 && (
                <ul className="mt-3 space-y-2 pl-[18px]">
                  {row.works.map((work) => (
                    <li key={work.id} className="min-w-0">
                      {onOpenGoals ? (
                        <button
                          type="button"
                          className="block w-full truncate text-left text-xs text-l2 hover:text-l1"
                          onClick={onOpenGoals}
                        >
                          {work.name}
                        </button>
                      ) : (
                        <p className="truncate text-xs text-l2">{work.name}</p>
                      )}
                      <p className="truncate text-micro text-l4">{work.statusLabel}</p>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {roster.rows.length > 0 &&
        roster.rows.every((row) => row.works.length === 0) &&
        roster.unassigned.length === 0 && (
          <p className="mt-3 px-1 text-micro text-l4">
            {projectAgentsEmptyWorkHint(project.workMode)}
            {onOpenGoals && project.workMode !== "coding" && (
              <button
                type="button"
                className="ml-1 text-l3 underline-offset-2 hover:text-l1 hover:underline"
                onClick={onOpenGoals}
              >
                去任务页
              </button>
            )}
          </p>
        )}
      {roster.unassigned.length > 0 && (
        <div className="mt-4 px-1">
          <p className="text-xs text-l3">还没指定 Agent 的目标</p>
          <ul className="mt-2 space-y-2">
            {roster.unassigned.map((work) => (
              <li key={work.id} className="min-w-0">
                {onOpenGoals ? (
                  <button
                    type="button"
                    className="block w-full truncate text-left text-xs text-l2 hover:text-l1"
                    onClick={onOpenGoals}
                  >
                    {work.name}
                  </button>
                ) : (
                  <p className="truncate text-xs text-l2">{work.name}</p>
                )}
                <p className="truncate text-micro text-l4">{work.statusLabel}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ProfileMenu({
  row,
  disabled,
  onPick,
  onAdd,
}: {
  row: ProjectAgentRow;
  disabled: boolean;
  onPick: (profileId: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const line = currentProfileLine(row);
  const currentId = row.defaultProfileId || row.profiles[0]?.id || "";

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="换这个项目用的配置。只影响本项目，不改 Mesa 启动栏，也不写 CLI 全局文件。"
        className="inline-flex h-7 max-w-full items-center gap-1 text-xs text-l3 hover:text-l1 disabled:opacity-50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{line}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 z-20 mt-1 min-w-44 max-w-72 rounded-md border border-field py-1 ccode-float-surface"
        >
          {row.profiles.map((profile) => {
            const selected = profile.id === currentId;
            return (
              <li key={profile.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`flex h-7 w-full items-center px-2.5 text-left text-xs ${
                    selected ? "bg-hover text-l1" : "text-l3 hover:bg-hover hover:text-l1"
                  }`}
                  onClick={() => {
                    onPick(profile.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{profile.modelLine}</span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="flex h-7 w-full items-center px-2.5 text-left text-xs text-l4 hover:bg-hover hover:text-l1"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              去连接页添加
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
