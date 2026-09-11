/**
 * 终端会话恢复的标签复用与配置挑选纯逻辑（2026-09-08 审计修复）。
 *
 * 两条规则：
 * 1. resume 兜底找「正持有这条会话」的活标签时只按 runId 或 agent+sessionId 认身份；
 *    cwd 相同不算数——同目录的别家 agent / shell 标签不是这条会话的持有者，
 *    抢过去等于把 Codex 会话恢复到 Claude 标签上。
 * 2. 恢复请求显式带了原配置（runId 恢复带出的 run.profileId）时优先原配置，
 *    不按「上次使用」重新挑选覆盖；原配置已删除/停用时不静默替换，
 *    返回 reselectNeeded 让 UI 提示用户重选（停用口径与 resume-profile.ts 一致：
 *    自动路径跳过停用项，手动选择才允许）。
 * 3. 项目绑定（autoLaunchProfileId）要显示在启动栏：不能被 Codex 渠道兼容池
 *    静默换成上次的网关。渠道和这条会话不一致时预填绑定、不自动启动。
 */

import { pickResumeProfile } from "./resume-profile.ts";

export interface HolderTabLike {
  id: string;
  runId?: string;
  initialAgentId?: string;
}

export interface HolderStatusLike {
  alive: boolean;
  runId: string | null;
  sessionId: string | null;
  agentId: string;
}

/** 找正持有目标会话的活标签；没有则 undefined（调用方新开标签） */
export function findResumeHolderTab<T extends HolderTabLike>(
  tabs: readonly T[],
  statuses: Record<string, HolderStatusLike | undefined>,
  target: { runId?: string; agentId: string; sessionId: string },
): T | undefined {
  return tabs.find((t) => {
    const st = statuses[t.id];
    if (!st?.alive) return false;
    if (target.runId && (st.runId ?? t.runId ?? null) === target.runId)
      return true;
    const agent = st.agentId || t.initialAgentId;
    return st.sessionId === target.sessionId && agent === target.agentId;
  });
}

/** 已有 resume 标签但进程不在：再点「继续」应重试启动，不能只切过去看上次的失败。 */
export function shouldRelaunchResumeTab(st?: {
  alive?: boolean;
  running?: boolean;
} | null): boolean {
  return !(st?.alive || st?.running);
}

export interface ResumeLaunchRequest {
  agentId: string;
  provider?: string | null;
  /** 调用方显式指定的配置（runId 恢复带出的原配置） */
  profileId?: string;
  model?: string;
  autoLaunchProfileId?: string | null;
}

export interface ResumeLaunchPick {
  profileId: string;
  model: string;
  /** true = 原配置失效：只预填不自动启动，UI 需提示用户重选 */
  reselectNeeded: boolean;
  /** 项目默认能显示，但和这条会话上次的 Codex 渠道不同：预填默认，不自动启动 */
  channelChanged?: boolean;
}

export function resolveResumeLaunch<
  T extends {
    id: string;
    agent: string;
    models: string[];
    baseUrl: string | null;
    gatewayId?: string | null;
    accountType?: string | null;
  },
>(
  profiles: T[],
  req: ResumeLaunchRequest,
  hiddenIds?: readonly string[],
  lastProfileId?: string | null,
): ResumeLaunchPick {
  const hidden = hiddenIds ?? [];
  const preferredId = req.autoLaunchProfileId?.trim();
  if (preferredId) {
    const preferred = profiles.find(
      (p) => p.id === preferredId && p.agent === req.agentId,
    );
    if (preferred && !hidden.includes(preferred.id)) {
      const channelPick = pickResumeProfile(
        profiles,
        req.agentId,
        req.provider,
        preferred.id,
        hiddenIds,
      );
      return {
        profileId: preferred.id,
        model: req.model ?? preferred.models[0] ?? "",
        reselectNeeded: false,
        channelChanged: channelPick?.id !== preferred.id,
      };
    }
  }
  if (req.profileId) {
    const orig = profiles.find(
      (p) => p.id === req.profileId && p.agent === req.agentId,
    );
    if (orig && !hidden.includes(orig.id)) {
      return {
        profileId: orig.id,
        model: req.model ?? orig.models[0] ?? "",
        reselectNeeded: false,
      };
    }
    return { profileId: "", model: "", reselectNeeded: true };
  }
  const pick = pickResumeProfile(
    profiles,
    req.agentId,
    req.provider,
    lastProfileId,
    hiddenIds,
  );
  return {
    profileId: pick?.id ?? "",
    model: pick?.models[0] ?? "",
    reselectNeeded: false,
  };
}
