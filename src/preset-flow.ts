/**
 * 一键接入纯逻辑（与 DOM 解耦，node --test 直接单测）：
 * 推荐模型与实际目录求交、「同时绑到」的协议兼容目标推导、多 Agent 槽位拼装。
 */
import { AGENT_PROTOCOLS } from "./types.ts";
import { slotForAgent } from "./gateway-slot.ts";
import { apiKindOf } from "./profile-copy.ts";
import type { ProtocolSlots } from "./types.ts";
import type { ProviderPreset } from "./presets.ts";

/**
 * 推荐模型与目录求交：保推荐清单顺序，只保留目录里真实存在的；
 * 目录有而推荐没有的不自动加（「禁止整份目录预填」红线），交集空返回空。
 */
export function intersectCatalog(
  recommended: readonly string[],
  catalog: readonly string[],
): string[] {
  const have = new Set(catalog);
  return recommended.filter((id) => have.has(id));
}

export interface ExtraBindTarget {
  agent: string;
  /** 该 Agent 绑这条网关应携带的协议；无协议表的 Agent 为 null */
  protocol: string | null;
  ok: boolean;
  /** 不兼容时的说明（复选框禁用原因） */
  reason?: string;
}

/**
 * 「同时绑到」目标推导：按来源协议族过滤候选 Agent，并给出各自的绑定协议。
 * 多协议 Agent（qwen/kimi）的协议挑选顺序：先匹配族的 openai（第三方端点最稳），
 * 再该 Agent 默认协议，最后族内其余选项。
 */
export function extraBindTargets(
  sourceAgent: string,
  sourceProtocol: string | null,
  candidates: readonly string[],
): ExtraBindTarget[] {
  const family = apiKindOf(sourceAgent, sourceProtocol);
  return candidates
    .filter((agent) => agent !== sourceAgent)
    .map((agent) => {
      const spec = AGENT_PROTOCOLS[agent];
      if (!spec) {
        const ok = apiKindOf(agent, null) === family;
        return {
          agent,
          protocol: null,
          ok,
          reason: ok
            ? undefined
            : `协议不兼容：这个端点是 ${family} 协议，${agent} 用不上`,
        };
      }
      const matches = spec.options.filter(
        (opt) => apiKindOf(agent, opt) === family,
      );
      if (matches.length === 0) {
        return {
          agent,
          protocol: null,
          ok: false,
          reason: `协议不兼容：这个端点是 ${family} 协议，${agent} 用不上`,
        };
      }
      const protocol =
        matches.find((opt) => opt === "openai") ??
        matches.find((opt) => opt === spec.default) ??
        matches[0];
      return { agent, protocol, ok: true };
    });
}

/**
 * 新建网关时的槽位拼装（「同时绑到」需要其他 Agent 的槽也填上才能绑）：
 * 主槽 = 表单 Base URL；额外 Agent 的槽缺省回落同一地址（中转站同址惯例）；
 * provider 预设定义过的槽以预设值为准（智谱 responses 专用端点这类分槽差异）。
 * 主槽永远跟随表单 Base URL——预设只补充其他槽，不覆盖用户正在填的地址。
 */
export function gatewayDraftSlots(
  primary: { agent: string; protocol: string | null; baseUrl: string },
  extras: readonly { agent: string; protocol: string | null }[],
  preset: ProviderPreset | null,
): ProtocolSlots {
  const slots: ProtocolSlots = {};
  const primarySlot = slotForAgent(primary.agent, primary.protocol);
  slots[primarySlot] = primary.baseUrl;
  if (preset) {
    for (const [slot, url] of Object.entries(preset.slots)) {
      // 主槽永远跟随表单 Base URL（用户可能改过预设地址），其余槽以预设值为准
      if (slot !== primarySlot && url) slots[slot as keyof ProtocolSlots] = url;
    }
  }
  for (const extra of extras) {
    const slot = slotForAgent(extra.agent, extra.protocol);
    if (!slots[slot]) slots[slot] = primary.baseUrl;
  }
  return slots;
}

/** 两个模型名单是否逐项相同（判断预设推荐模型是否被用户动过） */
export function sameModelList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
