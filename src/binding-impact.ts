import { slotForAgent, type GatewaySlotName } from "./gateway-slot.ts";

const SLOT_LABEL: Record<GatewaySlotName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI 兼容",
  responses: "Responses",
  gemini: "Gemini",
  cursor: "Cursor",
};

export function protocolDisplayLabel(
  agent: string,
  protocol?: string | null,
): string {
  if (agent === "kimi" && protocol === "kimi") return "Kimi";
  if ((agent === "qwen" || agent === "kimi") && protocol) {
    if (protocol === "anthropic") return "Anthropic";
    if (protocol === "openai") return "OpenAI 兼容";
  }
  return SLOT_LABEL[slotForAgent(agent, protocol)];
}

export type BindingImpactInput = {
  accountType: "api" | "official";
  gatewayName?: string | null;
  agent: string;
  protocol?: string | null;
  defaultModel?: string | null;
  mesaLaunchDefault: boolean;
  cliGlobalWritten: boolean;
};

/** 一条配置的影响范围：网关 · 协议 · 默认模型 · Mesa 还是外部 CLI。 */
export function bindingImpactLine(input: BindingImpactInput): string {
  const parts: string[] = [];
  if (input.accountType === "official") {
    parts.push("官方账号", "跟随 CLI 登录");
  } else {
    parts.push(input.gatewayName?.trim() || "未绑定网关");
    parts.push(protocolDisplayLabel(input.agent, input.protocol));
    const model = input.defaultModel?.trim();
    parts.push(model ? `默认 ${model}` : "未选默认模型");
  }
  const effects: string[] = [];
  if (input.mesaLaunchDefault) effects.push("Mesa 启动预选");
  if (input.cliGlobalWritten) effects.push("外部 CLI 上次写入");
  parts.push(effects.length ? effects.join(" · ") : "仅 Mesa 内选用时生效");
  return parts.join(" · ");
}
