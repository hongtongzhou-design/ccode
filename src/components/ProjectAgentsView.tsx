import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Check, ChevronDown, Star } from "lucide-react";
import { useAppStore } from "../store";
import { AGENTS, type ProjectDto, type TaskDto } from "../types";
import { ghostActionClass } from "./PageFrame";
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
    <section aria-label="项目 Agents">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-l1">项目 Agents</h2>
          <p className="mt-1 text-xs text-l3">
            {projectAgentsHint(project.workMode)}
          </p>
        </div>
        <button
          type="button"
          className={`${ghostActionClass} shrink-0 gap-1`}
          onClick={() => setPage("profiles")}
        >
          管理连接
          <ArrowUpRight size={14} aria-hidden="true" />
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
        <ul aria-label="项目 Agent 名册" className="grid grid-cols-1 items-start gap-2 md:grid-cols-2">
          {roster.rows.map((row) => (
            <li
              key={row.agentId}
              className={`min-w-0 rounded-lg p-3 transition-colors ${
                row.isProjectDefault ? "bg-seg-sel" : "ccode-well"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: agentBrand(row.agentId) }}
                />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-l1">
                  {row.label}
                </h3>
                <button
                  type="button"
                  className={`${ghostActionClass} shrink-0 gap-1 ${row.isProjectDefault ? "font-medium text-l1" : ""}`}
                  disabled={saving}
                  aria-pressed={row.isProjectDefault}
                  aria-label={row.isProjectDefault ? `取消 ${row.label} 的项目默认` : `将 ${row.label} 设为项目默认`}
                  title={row.isProjectDefault
                    ? "取消本项目默认，不改 Mesa 启动栏或 CLI 全局配置"
                    : "只影响本项目的默认选择，不改 Mesa 启动栏或 CLI 全局配置"}
                  onClick={() => void saveAgent(row.isProjectDefault ? "" : row.agentId)}
                >
                  <Star size={13} fill={row.isProjectDefault ? "currentColor" : "none"} aria-hidden="true" />
                  {row.isProjectDefault ? "项目默认" : "设为默认"}
                </button>
              </div>
              <div className="mt-1 min-w-0 pl-2">
                {row.profiles.length === 0 ? (
                  <button
                    type="button"
                    className={ghostActionClass}
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
      {project.workMode !== "coding" &&
        roster.rows.length > 0 &&
        roster.rows.every((row) => row.works.length === 0) &&
        roster.unassigned.length === 0 && (
          <p className="mt-3 px-1 text-micro text-l4">
            {projectAgentsEmptyWorkHint(project.workMode)}
            {onOpenGoals && (
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = row.profiles.find((profile) => profile.id === row.defaultProfileId) ?? row.profiles[0];
  const line = currentProfileLine(row);
  const currentId = row.defaultProfileId || row.profiles[0]?.id || "";

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
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
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`更换 ${row.label} 的项目连接`}
        title={`${line ?? "还没有连接"}；只修改本项目的连接选择`}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover disabled:opacity-50"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-l2">{current?.name}</span>
          <span className="mt-0.5 block truncate text-xs text-l3">{current?.model}</span>
        </span>
        <ChevronDown size={14} className="shrink-0 text-l3" aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={`${row.label} 的项目连接`}
          className="ccode-float-surface absolute inset-x-0 z-50 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-md border border-field py-1"
        >
          {row.profiles.map((profile) => {
            const selected = profile.id === currentId;
            return (
              <li key={profile.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={disabled}
                  title={profile.modelLine}
                  className={`flex w-full items-center gap-2 px-2.5 py-2 text-left disabled:opacity-50 ${
                    selected ? "bg-hover text-l1" : "text-l2 hover:bg-hover hover:text-l1"
                  }`}
                  onClick={() => {
                    onPick(profile.id);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{profile.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-l3">{profile.model}</span>
                  </span>
                  {selected && <Check size={14} className="shrink-0" aria-hidden="true" />}
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
