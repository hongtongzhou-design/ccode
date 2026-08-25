import assert from "node:assert/strict";
import test from "node:test";
import { skillChainWarnings, skillOutputConflicts } from "../src/skill-conflicts.ts";
import type { SkillDto } from "../src/types.ts";

const skill = (name: string, outputs?: string[]) =>
  ({ name, outputs }) as SkillDto;

test("skillOutputConflicts：相同路径与目录/文件前缀都算相交", () => {
  const lib = [
    skill("a", ["papers/"]),
    skill("b", ["papers/inbox.md"]),
    skill("c", ["papers/"]),
    skill("d", ["figures/"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), [
    { a: "a", b: "b", output: "papers/" },
  ]);
  // 完全相同的路径（两技能都声明同一目录）
  assert.deepEqual(skillOutputConflicts(["a", "c"], lib), [
    { a: "a", b: "c", output: "papers/" },
  ]);
});

test("skillOutputConflicts：不相交与名字前缀误伤防护", () => {
  const lib = [
    skill("a", ["papers/"]),
    skill("b", ["figures/"]),
    skill("c", ["papers2/draft.md"]), // papers/ 不能误伤 papers2/
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), []);
  assert.deepEqual(skillOutputConflicts(["a", "c"], lib), []);
});

test("skillOutputConflicts：路径归一化（空白、反斜杠、重复斜杠、./ 前缀）", () => {
  const lib = [skill("a", [" notes/ "]), skill("b", [".\\notes\\inbox.md"])];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), [
    { a: "a", b: "b", output: "notes/" },
  ]);
});

test("skillOutputConflicts：空 outputs 与未入库技能不参与", () => {
  const lib = [skill("a", ["papers/"]), skill("b"), skill("c", [])];
  assert.deepEqual(skillOutputConflicts(["a", "b", "c", "ghost"], lib), []);
});

test("skillOutputConflicts：同一对技能多处相交只报一次（取第一个）", () => {
  const lib = [
    skill("a", ["notes/", "references.bib"]),
    skill("b", ["notes/inbox.md", "references.bib"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b"], lib), [
    { a: "a", b: "b", output: "notes/" },
  ]);
});

test("skillOutputConflicts：多对冲突逐对列出", () => {
  const lib = [
    skill("a", ["analysis/"]),
    skill("b", ["analysis/stats-check.md"]),
    skill("c", ["analysis/", "figures/"]),
  ];
  assert.deepEqual(skillOutputConflicts(["a", "b", "c"], lib), [
    { a: "a", b: "b", output: "analysis/" },
    { a: "a", b: "c", output: "analysis/" },
    { a: "b", b: "c", output: "analysis/stats-check.md" },
  ]);
});

const iface = (name: string, inputs?: string[], outputs?: string[], inferred = false) =>
  ({ name, inputs, outputs, interfaceInferred: inferred }) as SkillDto;

test("skillChainWarnings：读入有上游供给/目录覆盖/通配覆盖时不报", () => {
  const lib = [
    iface("lit-notes", ["papers/included.md", "references.bib"], ["notes/"]),
  ];
  // 精确供给 + 目录供给
  assert.deepEqual(
    skillChainWarnings(
      ["lit-notes"],
      lib,
      ["papers/", "references.bib"],
      ["notes/*.md"],
    ),
    [],
  );
  // 通配供给覆盖目录需求
  assert.deepEqual(
    skillChainWarnings(["lit-notes"], lib, ["papers/", "references.bib"], []),
    [],
  );
  const lib2 = [iface("fw", ["notes/"], ["outline.md"])];
  assert.deepEqual(
    skillChainWarnings(["fw"], lib2, ["notes/*.md"], ["outline.md"]),
    [],
  );
});

test("skillChainWarnings：读入无供给与产出未进预期产物分别报 input/output", () => {
  const lib = [
    iface("ext-skill", ["papers/corpus.csv"], ["report/summary.md"], true),
  ];
  const warnings = skillChainWarnings(
    ["ext-skill"],
    lib,
    ["papers/screening.md"],
    ["report.md"],
  );
  assert.deepEqual(warnings, [
    { skill: "ext-skill", kind: "input", path: "papers/corpus.csv", inferred: true },
    { skill: "ext-skill", kind: "output", path: "report/summary.md", inferred: true },
  ]);
});

test("skillChainWarnings：未入库/无接口技能不参与；预期产物为空不检 output 侧", () => {
  const lib = [iface("plain")];
  assert.deepEqual(
    skillChainWarnings(["plain", "ghost"], lib, [], ["x.md"]),
    [],
  );
  const lib2 = [iface("w", [], ["anything.md"])];
  assert.deepEqual(skillChainWarnings(["w"], lib2, [], []), []);
});

test("skillChainWarnings：路径归一化后判定（./ 前缀、反斜杠）", () => {
  const lib = [iface("s", ["./papers\\included.md"], [])];
  assert.deepEqual(
    skillChainWarnings(["s"], lib, ["papers/"], ["x.md"]),
    [],
  );
});
