/**
 * 科研开步启动配置：弹层里选 Agent/连接，确认后自动拉起。
 * 与问 AI 的记忆键独立（ccode.askAi），但挑选规则相同：记住的连接还在就用，否则该 Agent 第一个，再否则全局第一个。
 */
import type { AskAiRemembered } from "./ask-ai.ts";

export interface KickoffLaunch {
  agentId: string;
  profileId: string;
  model: string;
}

export function pickKickoffLaunch(
  profiles: readonly { id: string; agent: string; models?: string[] }[],
  remembered: AskAiRemembered | null,
  last?: { agentId?: string; profileId?: string; model?: string } | null,
): KickoffLaunch | null {
  if (profiles.length === 0) return null;
  const has = (id: string) => profiles.some((p) => p.id === id);
  const from = remembered ?? last ?? null;
  const profile =
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
