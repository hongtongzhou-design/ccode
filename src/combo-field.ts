/** 网关库逐模型策略三态：只消费求交 DTO，不自己查能力链。 */

export type PolicyFieldMode = "edit" | "readonly" | "hidden";

export type PolicyFieldInput = {
  /** 模型具备该能力（思考档要求 thinking；采样字段恒 true） */
  capable: boolean;
  /** 已绑 Agent 通道并集 supported 且体检未失败 */
  injectAllowed: boolean;
  /** 体检明确失败 */
  probeFailed: boolean;
  /** 网关上存了值 */
  stored: boolean;
};

/** 优先级：不会该能力 → 隐藏；体检失败 → 只读；通道可注入 → 可改；已存值但通道不通 → 只读；否则隐藏。 */
export function policyFieldMode(input: PolicyFieldInput): PolicyFieldMode {
  if (!input.capable) return "hidden";
  if (input.probeFailed) return "readonly";
  if (input.injectAllowed) return "edit";
  if (input.stored) return "readonly";
  return "hidden";
}

export const READONLY_CHANNEL_HINT = "已保存在网关，当前 CLI 没有通道";
export const READONLY_PROBE_HINT = "体检失败，启动不会注入这项";

export function policyFieldHint(input: PolicyFieldInput): string | null {
  if (policyFieldMode(input) !== "readonly") return null;
  if (input.probeFailed) return READONLY_PROBE_HINT;
  return READONLY_CHANNEL_HINT;
}
