import assert from "node:assert/strict";
import test from "node:test";
import {
  completionOptionsForTarget,
  isCompletionCompatible,
  normalizeCompletion,
} from "../src/human-task-completion.ts";

test("完成判定按落点类型收敛可选项", () => {
  assert.deepEqual(
    completionOptionsForTarget("papers/*.pdf").map((x) => x.value),
    ["exists", "manual", "all"],
  );
  assert.deepEqual(
    completionOptionsForTarget("submission/checklist.md").map((x) => x.value),
    ["exists", "manual", "no_placeholders", "decisions_cleared"],
  );
  assert.deepEqual(
    completionOptionsForTarget("papers/").map((x) => x.value),
    ["exists", "manual"],
  );
  assert.deepEqual(
    completionOptionsForTarget("papers/*/review.pdf").map((x) => x.value),
    ["exists", "manual"],
    "跨目录通配既不支持 all，也不应被 no_placeholders 当成单文件",
  );
});

test("落点变化后不会保存不可完成的判定组合", () => {
  assert.equal(isCompletionCompatible("papers/*.pdf", "all"), true);
  assert.equal(isCompletionCompatible("papers/*/review.pdf", "all"), false);
  assert.equal(isCompletionCompatible("papers/", "no_placeholders"), false);
  assert.equal(normalizeCompletion("papers/", "no_placeholders"), "exists");
  assert.equal(
    normalizeCompletion("submission/checklist.md", "no_placeholders"),
    "no_placeholders",
  );
});

test("裁决清单的判定只对单文件有效，目录与通配不接受", () => {
  const target = "manuscript/verification-decisions.md";
  assert.equal(isCompletionCompatible(target, "decisions_cleared"), true);
  assert.equal(normalizeCompletion(target, "decisions_cleared"), "decisions_cleared");
  assert.equal(isCompletionCompatible("manuscript/", "decisions_cleared"), false);
  assert.equal(isCompletionCompatible("manuscript/*.md", "decisions_cleared"), false);
  assert.equal(normalizeCompletion("manuscript/", "decisions_cleared"), "exists");
});
