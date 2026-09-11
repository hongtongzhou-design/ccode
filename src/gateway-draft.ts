import type {
  FetchModelsResultDto,
  GatewayModel,
  GatewayProbeDto,
  ProtocolSlots,
  SlotProbeSummary,
} from "./types";
import {
  agentForSlot,
  firstFilledCatalogSlot,
  PROBEABLE_GATEWAY_SLOTS,
  type GatewaySlotName,
} from "./gateway-slot.ts";

export function effectiveSlotUrl(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  key: GatewaySlotName,
  masterUrl: string,
): string {
  const own = (slots[key] ?? "").trim();
  return own || masterUrl.trim();
}

/** 五个槽都空、或都等于主输入（含主输入同步进槽的同址情况）。 */
export function slotsFollowMaster(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
): boolean {
  const keys: GatewaySlotName[] = [
    "anthropic",
    "openai",
    "responses",
    "gemini",
    "cursor",
  ];
  const filled = keys
    .map((key) => (slots[key] ?? "").trim())
    .filter(Boolean);
  if (filled.length === 0) return true;
  const master = masterUrl.trim();
  const expected = master || filled[0];
  return filled.every((url) => url === expected);
}

export function firstProbeableSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
): GatewaySlotName | null {
  return (
    PROBEABLE_GATEWAY_SLOTS.find((key) =>
      Boolean(effectiveSlotUrl(slots, key, masterUrl)),
    ) ?? null
  );
}

export function catalogSlotWalkOrder(prefer?: string | null): GatewaySlotName[] {
  const order: GatewaySlotName[] = ["anthropic", "openai", "responses", "gemini"];
  if (prefer && order.includes(prefer as GatewaySlotName)) {
    const first = prefer as GatewaySlotName;
    return [first, ...order.filter((slot) => slot !== first)];
  }
  return order;
}

export function catalogFetchSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
  prefer?: string | null,
): GatewaySlotName | null {
  const filled: Partial<Record<GatewaySlotName, string>> = {};
  for (const key of catalogSlotWalkOrder(prefer)) {
    const url = effectiveSlotUrl(slots, key, masterUrl);
    if (url) filled[key] = url;
  }
  return firstFilledCatalogSlot(filled, prefer);
}

/** 测试主按钮：优先上次拉目录成功的槽，避免同址时误打 Anthropic /messages。 */
export function primaryProbeSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>> | ProtocolSlots,
  masterUrl: string,
  prefer?: string | null,
): GatewaySlotName | null {
  const catalog = catalogFetchSlot(slots, masterUrl, prefer);
  if (catalog && PROBEABLE_GATEWAY_SLOTS.includes(catalog)) return catalog;
  return firstProbeableSlot(slots, masterUrl);
}

export function parseHeaderEnv(text: string): Record<string, string> {
  const headerEnv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    headerEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return headerEnv;
}

export function fetchedIdsToModels(
  ids: string[],
  fetchedAt: string,
  catalogSlot?: string | null,
): GatewayModel[] {
  return ids.map((id) => ({
    id,
    source: "fetched",
    status: "available",
    lastSeenAt: fetchedAt,
    catalogSlot: catalogSlot ?? null,
    temperature: null,
    topP: null,
    maxOutputTokens: null,
    reasoningEffort: null,
  }));
}

export function probeDtoToSummary(
  slot: string,
  dto: GatewayProbeDto,
): SlotProbeSummary {
  const basic = dto.checks.find((check) => check.message.startsWith("基础请求"));
  return {
    slot,
    lastOk: dto.ok,
    lastLatencyMs:
      basic?.latencyMs != null ? Number(basic.latencyMs) : null,
    lastProbeAt: new Date().toISOString(),
  };
}

export function fetchModelsInvokeArgs(input: {
  baseUrl: string;
  apiKey: string;
  noAuth: boolean;
  slot: GatewaySlotName;
  gatewayId?: string | null;
}): {
  baseUrl: string;
  apiKey: string | null;
  agentId: string;
  gatewayId: string | null;
  force: boolean;
} {
  return {
    baseUrl: input.baseUrl,
    apiKey: input.noAuth || !input.apiKey.trim() ? null : input.apiKey.trim(),
    agentId: agentForSlot(input.slot),
    gatewayId: input.gatewayId ?? null,
    force: true,
  };
}

export function applyFetchedCatalog(
  local: GatewayModel[],
  result: FetchModelsResultDto,
  slot: GatewaySlotName,
  merge: (local: GatewayModel[], incoming: GatewayModel[]) => GatewayModel[],
): GatewayModel[] {
  return merge(
    local,
    fetchedIdsToModels(result.models, result.fetchedAt, slot),
  );
}

/** 网关 /models 没带 OpenRouter 风格能力字段时的可见说明。 */
export function catalogCapabilityNote(
  modelCount: number,
  capabilityCount: number,
): string | null {
  if (modelCount <= 0) return null;
  if (capabilityCount > 0) {
    return `其中 ${capabilityCount} 个带网关能力字段（上下文/视觉/推理）`;
  }
  return "网关只返回模型 ID，没有上下文/视觉/推理。能力声明用连接页 ⋯「下载模型能力库」。";
}

export function catalogFetchNotice(
  modelCount: number,
  capabilityCount: number,
  slot?: string | null,
): string {
  const where = slot ? `（${slot}）` : "";
  const cap = catalogCapabilityNote(modelCount, capabilityCount);
  const head = `已获取 ${modelCount} 个模型${where}`;
  return cap ? `${head}。${cap}` : `${head}。`;
}
