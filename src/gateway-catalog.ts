import type { GatewayModel } from "./types";

/** 刷新目录只合并目录元数据，保留未保存的逐模型策略。 */
export function mergeGatewayCatalog(
  local: GatewayModel[],
  incoming: GatewayModel[],
): GatewayModel[] {
  const prev = new Map(local.map((m) => [m.id, m]));
  const out: GatewayModel[] = incoming.map((row) => {
    const keep = prev.get(row.id);
    if (!keep) return { ...row };
    return {
      ...row,
      temperature: keep.temperature,
      topP: keep.topP,
      maxOutputTokens: keep.maxOutputTokens,
      reasoningEffort: keep.reasoningEffort,
    };
  });
  for (const row of local) {
    if (!out.some((m) => m.id === row.id)) out.push(row);
  }
  return out;
}
