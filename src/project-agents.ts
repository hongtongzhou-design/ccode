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

export type ProjectAgentChoice = {
  id: string;
  name: string;
  /** 连接名单里的模型 id；空串 = 这条连接没有指定模型（CLI 默认） */
  modelId: string;
  model: string;
  modelLine: string;
};

export type ProjectAgentRow = {
  agentId: string;
  label: string;
  isProjectDefault: boolean;
  defaultProfileId: string;
  /** 本项目点选过的模型；空 = 用这条连接的第一个 */
  defaultModelId: string;
  profiles: ProjectAgentChoice[];
  works: ProjectAgentWork[];
};

function choiceFor(profile: ProjectAgentProfile, modelId: string): ProjectAgentChoice {
  const model = modelId || "CLI 默认";
  return {
    id: profile.id,
    name: profile.name,
    modelId,
    model,
    modelLine: `${profile.name} · ${model}`,
  };
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
  defaultModels?: Record<string, string> | null;
  tasks: readonly ProjectAgentTaskRef[];
  taskKinds: ReadonlySet<string>;
  workMode?: string | null;
}): { rows: ProjectAgentRow[]; unassigned: ProjectAgentWork[] } {
  const defaults = input.defaultProfiles ?? {};
  const modelDefaults = input.defaultModels ?? {};
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
      .flatMap((profile) => {
        const models = profile.models.length > 0 ? profile.models : [""];
        return models.map((modelId) => choiceFor(profile, modelId));
      });
    const boundId = defaults[agentId] ?? "";
    const boundModel = modelDefaults[agentId]?.trim() ?? "";
    const modelStillThere =
      !!boundModel &&
      profiles.some((profile) => profile.id === boundId && profile.modelId === boundModel);
    return {
      agentId,
      label: labelById.get(agentId) ?? agentId,
      isProjectDefault: agentId === projectDefault,
      defaultProfileId: boundId,
      defaultModelId: modelStillThere ? boundModel : "",
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

export function selectedProjectAgentProfile<T extends { id: string; modelId?: string }>(
  row: {
    defaultProfileId: string;
    defaultModelId?: string;
    profiles: readonly T[];
  },
): T | undefined {
  const wanted = row.defaultModelId?.trim() ?? "";
  return (
    (wanted
      ? row.profiles.find(
          (profile) => profile.id === row.defaultProfileId && profile.modelId === wanted,
        )
      : undefined) ??
    row.profiles.find((profile) => profile.id === row.defaultProfileId) ??
    row.profiles[0]
  );
}

export function currentProfileLine(
  row: Pick<ProjectAgentRow, "defaultProfileId" | "profiles"> & {
    defaultModelId?: string;
  },
): string | null {
  return selectedProjectAgentProfile(row)?.modelLine ?? null;
}

/** 记下的模型还在这条连接的名单里就用它，否则用名单第一个。 */
export function resolveProfileModel(
  models: readonly string[] | null | undefined,
  wanted?: string | null,
): string {
  const list = models ?? [];
  const model = wanted?.trim() ?? "";
  if (model && list.includes(model)) return model;
  return list[0] ?? "";
}

/** 项目 Agents 页为这家绑定的配置；空 = 未绑定，继续会话走原 Run / 上次使用。 */
export function projectBoundProfileId(
  defaultProfiles: Record<string, string> | null | undefined,
  agentId: string,
): string | undefined {
  const id = defaultProfiles?.[agentId]?.trim();
  return id || undefined;
}

/** 项目 Agents 名册 → 新会话启动。有项目默认 Agent 且这家有可用连接才返回；
 *  绑定已删则回落该 Agent 第一条。未设项目默认返回 null，由调用方去弹层选。 */
export function projectAgentLaunch(
  profiles: readonly { id: string; agent: string; models?: readonly string[] }[],
  defaultAgent?: string | null,
  defaultProfiles?: Record<string, string> | null,
  defaultModels?: Record<string, string> | null,
): { agentId: string; profileId: string; model: string } | null {
  const agent = defaultAgent?.trim() ?? "";
  if (!agent) return null;
  const forAgent = profiles.filter((p) => p.agent === agent);
  if (forAgent.length === 0) return null;
  const bound = defaultProfiles?.[agent]?.trim() ?? "";
  const profile = (bound && forAgent.find((p) => p.id === bound)) || forAgent[0]!;
  return {
    agentId: agent,
    profileId: profile.id,
    model: resolveProfileModel(profile.models, defaultModels?.[agent]),
  };
}

/** 项目默认 Agent、连接、以及这条连接里点选的模型。没设项目默认时三个都空。 */
export function projectAgentPrefs(project?: {
  defaultAgent?: string | null;
  defaultProfiles?: Record<string, string> | null;
  defaultModels?: Record<string, string> | null;
} | null): {
  preferredAgent?: string;
  preferredProfile?: string;
  preferredModel?: string;
} {
  const preferredAgent = project?.defaultAgent?.trim() || undefined;
  if (!preferredAgent) return {};
  const preferredProfile = project?.defaultProfiles?.[preferredAgent]?.trim() || undefined;
  const preferredModel = project?.defaultModels?.[preferredAgent]?.trim() || undefined;
  return {
    preferredAgent,
    ...(preferredProfile ? { preferredProfile } : {}),
    ...(preferredModel ? { preferredModel } : {}),
  };
}
