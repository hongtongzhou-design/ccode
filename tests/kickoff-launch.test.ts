import assert from "node:assert/strict";
import test from "node:test";
import {
  kickoffLaunchLabel,
  pickKickoffLaunch,
} from "../src/kickoff-launch.ts";
import {
  expectedDeliverLine,
  expectedDeliverNames,
  formatKickoffChip,
  chipFileName,
} from "../src/kickoff-inputs.ts";

const profiles = [
  { id: "p-claude", agent: "claude-code", name: "中转 A", models: ["sonnet"] },
  { id: "p-codex", agent: "codex", name: "官方", models: ["gpt-5"] },
];

test("pickKickoffLaunch：无连接返回 null", () => {
  assert.equal(pickKickoffLaunch([], null), null);
});

test("pickKickoffLaunch：优先记住的连接", () => {
  const picked = pickKickoffLaunch(profiles, {
    agentId: "codex",
    profileId: "p-codex",
    model: "gpt-5",
    useDefault: true,
  });
  assert.deepEqual(picked, {
    agentId: "codex",
    profileId: "p-codex",
    model: "gpt-5",
  });
});

test("pickKickoffLaunch：记住的连接已删则回落上次 Agent 的第一个", () => {
  const picked = pickKickoffLaunch(profiles, {
    agentId: "codex",
    profileId: "gone",
    model: "x",
    useDefault: true,
  });
  assert.equal(picked?.profileId, "p-codex");
});

test("pickKickoffLaunch：都没有则用列表第一个", () => {
  const picked = pickKickoffLaunch(profiles, null);
  assert.equal(picked?.profileId, "p-claude");
  assert.equal(picked?.model, "sonnet");
});

test("kickoffLaunchLabel：没有连接时说人话", () => {
  assert.equal(
    kickoffLaunchLabel(null, profiles, (id) => id),
    "还没有可用连接",
  );
});

test("formatKickoffChip：included 用篇、缺的标还没有", () => {
  assert.deepEqual(
    formatKickoffChip({
      pattern: "papers/included.md",
      role: "required",
      present: true,
      count: 12,
    }),
    { label: "included.md · 12 篇", missing: false },
  );
  assert.deepEqual(
    formatKickoffChip({
      pattern: "notes/*.md",
      role: "required",
      present: true,
      count: 8,
    }),
    { label: "notes/ · 8 份", missing: false },
  );
  assert.equal(chipFileName("notes/*.md"), "notes/");
  assert.deepEqual(
    formatKickoffChip({
      pattern: "outline.md",
      role: "required",
      present: false,
      count: 0,
    }),
    { label: "outline.md · 还没有", missing: true },
  );
});

test("expectedDeliverLine：列出本步产物短名", () => {
  assert.deepEqual(expectedDeliverNames(["notes/*.md", "references.bib"]), [
    "notes/",
    "references.bib",
  ]);
  assert.equal(
    expectedDeliverLine(["notes/*.md", "references.bib"]),
    "本步要交：notes/、references.bib",
  );
  assert.equal(expectedDeliverLine([]), "按任务书交付本步产物");
});
