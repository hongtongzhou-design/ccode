import assert from "node:assert/strict";
import test from "node:test";
import { stepEvidenceLabel, stepEvidenceSummary } from "../src/step-evidence.ts";

test("步骤卡只认报告里写明的质量状态和未决标记", () => {
  const text = [
    "## 验收摘要",
    "- 质量状态：已生成待审",
    "正文有 [待核实] 两处，其中一处是 [待核实]。",
    "规则还标了 [待确认]。",
  ].join("\n");
  assert.equal(
    stepEvidenceLabel(stepEvidenceSummary(text)),
    "已生成待审 · 待核实 2 · 待确认 1",
  );
});

test("没有状态也没有标记时步骤卡不显示", () => {
  assert.equal(stepEvidenceLabel(stepEvidenceSummary("普通段落")), null);
});

test("阻塞和限定范围的证据通过保持原词", () => {
  assert.equal(
    stepEvidenceSummary("质量状态：证据通过（限定范围）").status,
    "证据通过（限定范围）",
  );
  assert.equal(stepEvidenceSummary("质量状态：**阻塞**").status, "阻塞");
});
