import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectAgentRoster,
  currentProfileLine,
  projectAgentLaunch,
  projectAgentPrefs,
  projectAgentsEmptyWorkHint,
  projectAgentsHint,
  projectNeedsDefaultAgent,
  projectBoundProfileId,
  resolveProfileModel,
  resolvedTaskAgentId,
} from "../src/project-agents.ts";
import { declaredTaskKindsForMode, taskStatusLabel } from "../src/project-tasks.ts";

const catalog = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini CLI" },
];

const profiles = [
  { id: "p-claude", agent: "claude-code", name: "中转 A", models: ["sonnet"] },
  { id: "p-codex", agent: "codex", name: "官方", models: ["gpt-5"] },
  { id: "p-codex-2", agent: "codex", name: "网关", models: ["gpt-5-mini"] },
];

function task(
  partial: Partial<{
    id: string;
    name: string;
    status: string;
    kind: string;
    agent: string | null;
    inputPaths: string[];
    declared: boolean;
  }>,
) {
  return {
    id: "t1",
    name: "整理筛选清单",
    status: "pending",
    kind: "free_research",
    agent: "codex",
    inputPaths: ["papers/included.md"],
    declared: true,
    ...partial,
  };
}

test("resolvedTaskAgentId prefers the step agent over project default", () => {
  assert.equal(resolvedTaskAgentId({ agent: "codex" }, "claude-code"), "codex");
  assert.equal(resolvedTaskAgentId({ agent: null }, "claude-code"), "claude-code");
  assert.equal(resolvedTaskAgentId({ agent: "  " }, null), "");
});

test("roster lists every configured agent with its own default profile", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: { "claude-code": "p-claude", codex: "p-codex-2" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  assert.deepEqual(
    rows.map((row) => ({
      id: row.agentId,
      isDefault: row.isProjectDefault,
      profile: row.defaultProfileId,
    })),
    [
      { id: "codex", isDefault: true, profile: "p-codex-2" },
      { id: "claude-code", isDefault: false, profile: "p-claude" },
    ],
  );
  assert.equal(unassigned.length, 0);
  assert.equal(rows.find((row) => row.agentId === "codex")?.profiles.length, 2);
});

test("declared tasks attach to the assigned agent and show status", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "claude-code",
    defaultProfiles: {},
    tasks: [
      task({ id: "a", agent: "codex", inputPaths: ["notes"] }),
      task({
        id: "b",
        name: "起草回复",
        agent: null,
        inputPaths: [],
        kind: "office_doc",
      }),
      task({
        id: "junk",
        name: "/Users/me/proj",
        declared: false,
        agent: "codex",
      }),
    ],
    taskKinds: new Set(["free_research", "office_doc"]),
  });
  const codex = rows.find((row) => row.agentId === "codex");
  const claude = rows.find((row) => row.agentId === "claude-code");
  assert.deepEqual(codex?.works.map((work) => `${work.name}:${work.statusLabel}`), [
    "整理筛选清单:尚未开始",
  ]);
  assert.deepEqual(claude?.works.map((work) => `${work.name}:${work.statusLabel}`), [
    "起草回复:尚未开始",
  ]);
  assert.equal(unassigned.length, 0);
});

test("tasks without an agent stay unassigned when the project has no default", () => {
  const { rows, unassigned } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: null,
    defaultProfiles: {},
    tasks: [task({ agent: null })],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  assert.equal(
    rows.every((row) => row.works.length === 0),
    true,
  );
  assert.deepEqual(
    unassigned.map((work) => work.name),
    ["整理筛选清单"],
  );
});

test("coding projects still get a roster but no declared-task kinds", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: {},
    tasks: [task({})],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.equal(rows.some((row) => row.works.length > 0), false);
  assert.equal(declaredTaskKindsForMode("coding").size, 0);
});

test("hidden profiles stay visible when they are this project's default", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles,
    hiddenProfileIds: ["p-codex-2"],
    defaultAgent: "codex",
    defaultProfiles: { codex: "p-codex-2" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("office"),
  });
  const codex = rows.find((row) => row.agentId === "codex");
  assert.equal(codex?.profiles.some((profile) => profile.id === "p-codex-2"), true);
});

test("an assigned agent still appears even if it currently has no connection", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: profiles.filter((profile) => profile.agent !== "gemini"),
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: {},
    tasks: [task({ agent: "gemini" })],
    taskKinds: declaredTaskKindsForMode("research"),
  });
  const gemini = rows.find((row) => row.agentId === "gemini");
  assert.equal(gemini?.label, "Gemini CLI");
  assert.equal(gemini?.profiles.length, 0);
  assert.equal(gemini?.works[0]?.name, "整理筛选清单");
});

test("hints stay short and never promise routing", () => {
  for (const mode of ["office", "coding", "research"]) {
    assert.equal(projectAgentsHint(mode), "默认选择仅对本项目生效。");
  }
  assert.equal(projectNeedsDefaultAgent({ defaultAgent: "" }), true);
  assert.equal(projectNeedsDefaultAgent({ defaultAgent: "claude" }), false);
  assert.equal(projectAgentsEmptyWorkHint("research"), "新建目标或开步时指定谁干。");
  assert.equal(projectAgentsEmptyWorkHint("office"), "新建目标时指定谁写文档。");
  assert.equal(projectAgentsEmptyWorkHint("coding"), "在工作树里选谁开工。");
  assert.equal(taskStatusLabel("pending_review"), "待验收");
  assert.equal(taskStatusLabel("running"), "进行中");
});

test("currentProfileLine shows the project pick, else the first connection", () => {
  assert.equal(
    currentProfileLine({
      defaultProfileId: "p-codex-2",
      profiles: [
        { id: "p-codex", name: "官方", model: "gpt-5", modelLine: "官方 · gpt-5" },
        { id: "p-codex-2", name: "网关", model: "gpt-5-mini", modelLine: "网关 · gpt-5-mini" },
      ],
    }),
    "网关 · gpt-5-mini",
  );
  assert.equal(
    currentProfileLine({
      defaultProfileId: "",
      profiles: [{ id: "p-codex", name: "官方", model: "gpt-5", modelLine: "官方 · gpt-5" }],
    }),
    "官方 · gpt-5",
  );
  assert.equal(currentProfileLine({ defaultProfileId: "", profiles: [] }), null);
});

test("projectBoundProfileId uses the project binding for that agent", () => {
  const bound = { kimi: "p-kimi-a", "claude-code": "p-claude" };
  assert.equal(projectBoundProfileId(bound, "kimi"), "p-kimi-a");
  assert.equal(projectBoundProfileId(bound, "codex"), undefined);
  assert.equal(projectBoundProfileId({}, "kimi"), undefined);
  assert.equal(projectBoundProfileId({ kimi: "  " }, "kimi"), undefined);
});

test("projectAgentLaunch uses the Agents roster, not last launch", () => {
  assert.equal(projectAgentLaunch(profiles, null, { codex: "p-codex-2" }), null);
  assert.deepEqual(projectAgentLaunch(profiles, "codex", { codex: "p-codex-2" }), {
    agentId: "codex",
    profileId: "p-codex-2",
    model: "gpt-5-mini",
  });
  assert.equal(projectAgentLaunch(profiles, "codex", { codex: "gone" })?.profileId, "p-codex");
  assert.equal(projectAgentLaunch(profiles, "gemini", {}), null);
});

test("a connection lists every model, and the project pick wins over the first", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: [
      {
        id: "p-grok",
        agent: "codex",
        name: "Test",
        models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"],
      },
    ],
    hiddenProfileIds: [],
    defaultAgent: "codex",
    defaultProfiles: { codex: "p-grok" },
    defaultModels: { codex: "deepseek-v4.1-flash" },
    tasks: [],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.deepEqual(
    rows[0].profiles.map((profile) => profile.model),
    ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"],
  );
  assert.equal(rows[0].defaultModelId, "deepseek-v4.1-flash");
  assert.equal(
    currentProfileLine(rows[0]),
    "Test · deepseek-v4.1-flash",
  );
  const launch = projectAgentLaunch(
    [{ id: "p-grok", agent: "codex", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
    "codex",
    { codex: "p-grok" },
    { codex: "deepseek-v4.1-flash" },
  );
  assert.equal(launch?.model, "deepseek-v4.1-flash");
  assert.equal(
    projectAgentLaunch(
      [{ id: "p-grok", agent: "codex", models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash"] }],
      "codex",
      { codex: "p-grok" },
      { codex: "gone" },
    )?.model,
    "deepseek-v4-flash-0731",
  );
  assert.equal(resolveProfileModel(["a", "b"], "b"), "b");
  assert.equal(resolveProfileModel(["a"], "gone"), "a");
  assert.deepEqual(
    projectAgentPrefs({
      defaultAgent: "codex",
      defaultProfiles: { codex: "p-grok" },
      defaultModels: { codex: "deepseek-v4.1-flash" },
    }),
    {
      preferredAgent: "codex",
      preferredProfile: "p-grok",
      preferredModel: "deepseek-v4.1-flash",
    },
  );
});

test("roster keeps connection names and models separate, including names with separators", () => {
  const { rows } = buildProjectAgentRoster({
    catalog,
    profiles: [
      { id: "named", agent: "codex", name: "科研 · 精读", models: ["gpt-6-astra"] },
      { id: "default", agent: "codex", name: "CLI", models: [] },
    ],
    hiddenProfileIds: [],
    defaultAgent: null,
    defaultProfiles: {},
    tasks: [],
    taskKinds: declaredTaskKindsForMode("coding"),
  });
  assert.deepEqual(rows[0].profiles.map(({ name, model }) => ({ name, model })), [
    { name: "科研 · 精读", model: "gpt-6-astra" },
    { name: "CLI", model: "CLI 默认" },
  ]);
});
