import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { BUILTIN_USAGE_GROUPS, groupByUsage, skillSummary } from "../src/skill-list-display.ts";

test("描述只取第一句：中文到「。」，英文到「. 」，取不出原样", () => {
  assert.equal(skillSummary("文献检索与筛选规范。当用户要求……时使用。"), "文献检索与筛选规范");
  assert.equal(
    skillSummary("Write and revise empirical research papers. Use for IMRaD manuscripts."),
    "Write and revise empirical research papers",
  );
  assert.equal(skillSummary("  只有一句没有句号  "), "只有一句没有句号");
  assert.equal(skillSummary("v1.2 版本说明。其余"), "v1.2 版本说明", "版本号里的点不算句末");
  assert.equal(skillSummary(""), "");
});

test("用途分组：随包的内置技能每个都登记了小节，不落「其他」", () => {
  const shipped = readdirSync(new URL("../src-tauri/resources/skills/", import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const listed = BUILTIN_USAGE_GROUPS.flatMap((g) => g.names);
  for (const name of shipped) assert.ok(listed.includes(name), `${name} 没登记用途小节`);
  assert.equal(new Set(listed).size, listed.length, "一个技能只进一个小节");
});

test("用途分组：空小节不出，节内保持原顺序，没登记的落「其他」", () => {
  const groups = groupByUsage([{ name: "stats-check" }, { name: "lit-notes" }, { name: "x" }, { name: "lit-search" }]);
  assert.deepEqual(
    groups.map((g) => [g.label, g.skills.map((s) => s.name)]),
    [
      ["文献", ["lit-notes", "lit-search"]],
      ["审查与校对", ["stats-check"]],
      ["其他", ["x"]],
    ],
  );
});
