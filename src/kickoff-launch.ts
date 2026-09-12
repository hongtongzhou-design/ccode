/**
 * 科研开步启动配置：弹层里选 Agent/连接，确认后自动拉起。
 * 项目内新会话优先 Agents 名册；没有项目默认才回落问 AI 记忆 / 上次使用。
 */
import { askAiCanSkip, type AskAiRemembered } from "./ask-ai.ts";
import { projectAgentLaunch } from "./project-agents.ts";

export interface KickoffLaunch {
  agentId: string;
  profileId: string;
  model: string;
}

export function pickKickoffLaunch(
  profiles: readonly { id: string; agent: string; models?: string[] }[],
  remembered: AskAiRemembered | null,
  last?: { agentId?: string; profileId?: string; model?: string } | null,
  preferredAgent?: string | null,
  preferredProfile?: string | null,
): KickoffLaunch | null {
  if (profiles.length === 0) return null;
  const has = (id: string) => profiles.some((p) => p.id === id);
  const from = remembered ?? last ?? null;
  const profile =
    (preferredProfile &&
    (!preferredAgent ||
      profiles.find((p) => p.id === preferredProfile)?.agent === preferredAgent)
      ? profiles.find((p) => p.id === preferredProfile) ?? null
      : null) ??
    (preferredAgent
      ? profiles.find((p) => p.agent === preferredAgent) ?? null
      : null) ??
    (from?.profileId && has(from.profileId)
      ? profiles.find((p) => p.id === from.profileId)
      : null) ??
    (from?.agentId
      ? profiles.find((p) => p.agent === from.agentId)
      : null) ??
    profiles[0]!;
  const models = profile.models ?? [];
  const wanted = from?.model?.trim() ?? "";
  const model =
    wanted && (models.length === 0 || models.includes(wanted))
      ? wanted
      : (models[0] ?? "");
  return { agentId: profile.agent, profileId: profile.id, model };
}

/** 编程开工 / 进入工作树：项目绑了 Agents 就直接拉起，否则记住的默认连接可直接拉起。 */
export function codingTerminalLaunch(
  profiles: readonly { id: string; agent: string; models?: string[] }[],
  remembered: AskAiRemembered | null,
  preferredAgent?: string | null,
  preferredProfile?: string | null,
): {
  agentId: string;
  profileId: string;
  model: string;
  autoStart: boolean;
} | null {
  const project = projectAgentLaunch(
    profiles,
    preferredAgent,
    preferredAgent
      ? { [preferredAgent]: preferredProfile?.trim() ?? "" }
      : null,
  );
  const launch =
    project ??
    pickKickoffLaunch(
      profiles,
      remembered,
      null,
      preferredAgent,
      preferredProfile,
    );
  if (!launch) return null;
  return {
    ...launch,
    autoStart: !!project || askAiCanSkip(remembered, profiles),
  };
}

export function kickoffLaunchLabel(
  launch: KickoffLaunch | null,
  profiles: readonly { id: string; name?: string; agent: string }[],
  agentLabel: (id: string) => string,
): string {
  if (!launch) return "还没有可用连接";
  const p = profiles.find((x) => x.id === launch.profileId);
  const agent = agentLabel(launch.agentId);
  const name = p?.name?.trim();
  const model = launch.model.trim();
  if (name && model) return `${agent} · ${name} · ${model}`;
  if (name) return `${agent} · ${name}`;
  return agent;
}
