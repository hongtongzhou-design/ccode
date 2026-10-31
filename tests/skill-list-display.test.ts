import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { BUILTIN_USAGE_GROUPS, groupByUsage, usageGroupOf } from "../src/skill-list-display.ts";

test("用途归属：登记过的按小节，用户自己的技能落「其他」", () => {
  assert.equal(usageGroupOf("lit-search"), "文献");
  assert.equal(usageGroupOf("stats-check"), "审查与校对");
  assert.equal(usageGroupOf("apple-design"), "其他");
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
