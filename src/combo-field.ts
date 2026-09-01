/** 网关库逐模型策略三态：只消费求交 DTO，不自己查能力链。 */

export type PolicyFieldMode = "edit" | "readonly" | "hidden";

export type PolicyFieldInput = {
  /** 模型具备该能力（思考档要求 thinking；采样字段恒 true） */
  capable: boolean;
  /** 已绑 Agent 通道并集为 inject（启动注入）且体检未失败 */
  injectAllowed: boolean;
  /**
   * 通道种类并集（inject/persist/tui/unsupported/unknown，来自求交 DTO 的 channel* 字段）：
   * persist = 仅「设为全局默认」写盘生效（可编辑可存，启动不注）；
   * tui = 仅会话内原生命令（存储值不携带）
   */
  channel?: string;
  /** 体检明确失败 */
  probeFailed: boolean;
  /** 网关上存了值 */
  stored: boolean;
};

/** 优先级：不会该能力 → 隐藏；体检失败 → 只读；启动可注入 → 可改；persist 通道 → 可改（仅设为全局生效）；
    已存值但通道不通/仅 TUI → 只读；否则隐藏。 */
export function policyFieldMode(input: PolicyFieldInput): PolicyFieldMode {
  if (!input.capable) return "hidden";
  if (input.probeFailed) return "readonly";
  if (input.injectAllowed) return "edit";
  if (input.channel === "persist") return "edit";
  if (input.stored) return "readonly";
  return "hidden";
}

export const READONLY_CHANNEL_HINT = "已保存在网关，当前 CLI 没有通道";
export const READONLY_PROBE_HINT = "体检失败，启动不会注入这项";
export const READONLY_TUI_HINT = "仅会话内原生命令（如 /effort）生效，启动与写盘不携带";

/** 通道种类 → badge 标签（能力表逐字段标注用）：inject/persist/tui/unsupported/未知 */
export function channelLabel(channel: string | undefined): string {
  switch (channel) {
    case "inject":
      return "支持";
    case "persist":
      return "仅设为全局";
    case "tui":
      return "会话内命令";
    case "unsupported":
      return "不支持";
    default:
      return "未知";
  }
}

export function policyFieldHint(input: PolicyFieldInput): string | null {
  if (policyFieldMode(input) !== "readonly") return null;
  if (input.probeFailed) return READONLY_PROBE_HINT;
  if (input.channel === "tui") return READONLY_TUI_HINT;
  return READONLY_CHANNEL_HINT;
}
