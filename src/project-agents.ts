import {
  goalDisplayName,
  taskStatusLabel,
  visibleDeclaredTasks,
} from "./project-tasks.ts";
import { goalReviewCopy } from "./goal-review.ts";

export type AgentCatalogItem = { id: string; label: string };

export type ProjectAgentProfile = {
  id: string;
  agent: string;
  name: string;
  models: readonly string[];
};

export type ProjectAgentTaskRef = {
  id: string;
  name: string;
  status: string;
  kind: string;
  agent: string | null;
  inputPaths: readonly string[];
  description?: string | null;
  declared?: boolean;
};

export type ProjectAgentWork = {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
};

export type ProjectAgentRow = {
  agentId: string;
  label: string;
  isProjectDefault: boolean;
  defaultProfileId: string;
  profiles: { id: string; name: string; model: string; modelLine: string }[];
  works: ProjectAgentWork[];
};

function profileLine(profile: ProjectAgentProfile): string {
  return `${profile.name} · ${profile.models[0] || "CLI 默认"}`;
}

function asWork(
  task: ProjectAgentTaskRef,
  workMode?: string | null,
): ProjectAgentWork {
  const copy = goalReviewCopy(workMode);
  const statusLabel =
    task.status === "pending_review" ? copy.bucketReview : taskStatusLabel(task.status);
  return {
    id: task.id,
    name: goalDisplayName(task),
    status: task.status,
    statusLabel,
  };
}

export function resolvedTaskAgentId(
  task: { agent: string | null },
  projectDefault: string | null | undefined,
): string {
  const assigned = task.agent?.trim() ?? "";
  if (assigned) return assigned;
  return projectDefault?.trim() ?? "";
}

export function buildProjectAgentRoster(input: {
  catalog: readonly AgentCatalogItem[];
  profiles: readonly ProjectAgentProfile[];
  hiddenProfileIds: readonly string[];
  defaultAgent: string | null | undefined;
  defaultProfiles: Record<string, string> | null | undefined;
  tasks: readonly ProjectAgentTaskRef[];
  taskKinds: ReadonlySet<string>;
  workMode?: string | null;
}): { rows: ProjectAgentRow[]; unassigned: ProjectAgentWork[] } {
  const defaults = input.defaultProfiles ?? {};
  const projectDefault = input.defaultAgent?.trim() || "";
  const hidden = new Set(input.hiddenProfileIds);
  const visibleProfiles = input.profiles.filter(
    (profile) => !hidden.has(profile.id) || Object.values(defaults).includes(profile.id),
  );
  const declared = visibleDeclaredTasks(input.tasks, input.taskKinds);
  const labelById = new Map(input.catalog.map((agent) => [agent.id, agent.label]));
  const catalogIndex = new Map(input.catalog.map((agent, index) => [agent.id, index]));

  const agentIds: string[] = [];
  const seen = new Set<string>();
  function addAgent(id: string) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    agentIds.push(id);
  }
  if (projectDefault) addAgent(projectDefault);
  for (const agent of input.catalog) {
    if (visibleProfiles.some((profile) => profile.agent === agent.id)) addAgent(agent.id);
  }
  for (const task of declared) {
    const id = task.agent?.trim() ?? "";
    if (id) addAgent(id);
  }

  agentIds.sort((a, b) => {
    if (a === projectDefault) return -1;
    if (b === projectDefault) return 1;
    return (catalogIndex.get(a) ?? 99) - (catalogIndex.get(b) ?? 99);
  });

  const unassigned: ProjectAgentWork[] = [];
  const worksByAgent = new Map<string, ProjectAgentWork[]>();
  for (const task of declared) {
    const agentId = resolvedTaskAgentId(task, projectDefault);
    if (!agentId) {
      unassigned.push(asWork(task, input.workMode));
      continue;
    }
    const list = worksByAgent.get(agentId) ?? [];
    list.push(asWork(task, input.workMode));
    worksByAgent.set(agentId, list);
  }

  const rows: ProjectAgentRow[] = agentIds.map((agentId) => {
    const profiles = visibleProfiles
      .filter((profile) => profile.agent === agentId)
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        model: profile.models[0] || "CLI 默认",
        modelLine: profileLine(profile),
      }));
    return {
      agentId,
      label: labelById.get(agentId) ?? agentId,
      isProjectDefault: agentId === projectDefault,
      defaultProfileId: defaults[agentId] ?? "",
      profiles,
      works: worksByAgent.get(agentId) ?? [],
    };
  });

  return { rows, unassigned };
}

export function projectAgentsHint(_workMode: string | null | undefined): string {
  return "默认选择仅对本项目生效。";
}

/** 名册上不逐家重复空状态；整页没有目标时才说一次。 */
export function projectAgentsEmptyWorkHint(
  workMode: string | null | undefined,
): string {
  if (workMode === "coding") return "在工作树里选谁开工。";
  if (workMode === "office") return "新建目标时指定谁写文档。";
  return "新建目标或开步时指定谁干。";
}

export function currentProfileLine(
  row: Pick<ProjectAgentRow, "defaultProfileId" | "profiles">,
): string | null {
  const selected = row.profiles.find((profile) => profile.id === row.defaultProfileId);
  if (selected) return selected.modelLine;
  return row.profiles[0]?.modelLine ?? null;
}

/** 项目 Agents 页为这家绑定的配置；空 = 未绑定，继续会话走原 Run / 上次使用。 */
export function projectBoundProfileId(
  defaultProfiles: Record<string, string> | null | undefined,
  agentId: string,
): string | undefined {
  const id = defaultProfiles?.[agentId]?.trim();
  return id || undefined;
}
