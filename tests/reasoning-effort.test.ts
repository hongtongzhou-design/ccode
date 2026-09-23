import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReasoningEffort, reasoningEffortValue } from "../src/reasoning-effort.ts";

test("单词旧值是单档", () => {
  assert.deepEqual(parseReasoningEffort("High"), {
    levels: ["high"],
    launch: "high",
  });
});

test("多选带开场默认", () => {
  assert.deepEqual(parseReasoningEffort("low,high,xhigh@high"), {
    levels: ["low", "high", "xhigh"],
    launch: "high",
  });
  assert.equal(reasoningEffortValue(["low", "high", "xhigh"], "high"), "low,high,xhigh@high");
});

test("斜杠串丢掉", () => {
  assert.deepEqual(parseReasoningEffort("hign/xhign"), { levels: [], launch: null });
  assert.equal(reasoningEffortValue([], null), null);
});
