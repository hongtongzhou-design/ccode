/** Agent → 网关协议槽（与 gateway_store::slot_for_agent 双端镜像，tests/gateway-slot.test.ts）。 */

export type GatewaySlotName =
  | "anthropic"
  | "openai"
  | "responses"
  | "gemini"
  | "cursor";

export function slotForAgent(
  agent: string,
  protocol?: string | null,
): GatewaySlotName {
  if (agent === "claude-code" || agent === "codebuddy") return "anthropic";
  if (agent === "codex") return "responses";
  if (agent === "gemini") return "gemini";
  if (agent === "cursor") return "cursor";
  if ((agent === "qwen" || agent === "kimi") && protocol === "anthropic") {
    return "anthropic";
  }
  return "openai";
}

export function firstFilledCatalogSlot(
  slots: Partial<Record<GatewaySlotName, string | null | undefined>>,
  prefer?: string | null,
): GatewaySlotName | null {
  const order: GatewaySlotName[] = [
    "anthropic",
    "openai",
    "responses",
    "gemini",
  ];
  const filled = (name: GatewaySlotName) => Boolean(slots[name]?.trim());
  if (prefer && order.includes(prefer as GatewaySlotName) && filled(prefer as GatewaySlotName)) {
    return prefer as GatewaySlotName;
  }
  return order.find(filled) ?? null;
}
