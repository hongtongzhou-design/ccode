import assert from "node:assert/strict";
import test from "node:test";
import { mergeGatewayCatalog } from "../src/gateway-catalog.ts";
import type { GatewayModel } from "../src/types.ts";

const row = (id: string, extra: Partial<GatewayModel> = {}): GatewayModel => ({
  id,
  source: "fetched",
  status: "available",
  lastSeenAt: null,
  temperature: null,
  topP: null,
  maxOutputTokens: null,
  reasoningEffort: null,
  ...extra,
});

test("刷新目录保留未保存策略，不丢手填模型", () => {
  const local = [
    row("a", { temperature: 0.2, reasoningEffort: "high" }),
    row("hand", { source: "user", temperature: 0.1 }),
  ];
  const incoming = [
    row("a", { status: "available", lastSeenAt: "t1" }),
    row("b", { status: "available" }),
  ];
  const merged = mergeGatewayCatalog(local, incoming);
  assert.equal(merged.find((m) => m.id === "a")?.temperature, 0.2);
  assert.equal(merged.find((m) => m.id === "a")?.reasoningEffort, "high");
  assert.equal(merged.find((m) => m.id === "a")?.lastSeenAt, "t1");
  assert.ok(merged.some((m) => m.id === "b"));
  assert.ok(merged.some((m) => m.id === "hand"));
});
