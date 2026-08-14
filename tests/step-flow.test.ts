import assert from "node:assert/strict";
import test from "node:test";
import { buildStepFlow } from "../src/step-flow.ts";
import type { HumanTaskStateDto, ProjectStepDto } from "../src/types.ts";

function ht(partial: Partial<HumanTaskStateDto>): HumanTaskStateDto {
  return {
    step: "检索筛选",
    title: "事项",
    guidance: "",
    target: "",
    timing: "during",
    detected: false,
    manual: false,
    done: false,
    ...partial,
  };
}

function step(partial: Partial<ProjectStepDto>): ProjectStepDto {
  return {
    name: "检索筛选",
    workspaceName: "lit",
    brief: "",
    expectedArtifacts: [],
    skills: [],
    run: [],
    ...partial,
  };
}

test("节点顺序：种子 → before → agent → during → after → 评审", () => {
  const flow = buildStepFlow({
    step: step({ discussionSeeds: ["角度怎么收？"] }),
    states: [
      ht({ title: "补文献", timing: "before" }),
      ht({ title: "补检索词", timing: "during" }),
      ht({ title: "下载付费", timing: "after" }),
    ],
    hasDraft: false,
    runStatus: "pending",
  });
  assert.deepEqual(
    flow.nodes.map((n) => `${n.kind}:${n.label}`),
    [
      "discuss:定方向：本步任务书",
      "human:补文献",
      "agent:agent 执行：检索筛选",
      "human:补检索词",
      "human:下载付费",
      "review:评审合并进主文件夹",
    ],
  );
  // 当前节点 = 第一个未完成（种子未聊）
  assert.equal(flow.currentKey, "discuss");
});

test("无种子步骤：discuss 节点恒在但直接完成；当前节点随完成推进", () => {
  const states = [ht({ title: "补文献", timing: "before", done: true })];
  const flow = buildStepFlow({
    step: step({}),
    states,
    hasDraft: false,
    runStatus: "active",
  });
  assert.deepEqual(
    flow.nodes.map((n) => n.kind),
    ["discuss", "human", "agent", "review"],
  );
  assert.equal(
    flow.nodes.find((n) => n.kind === "discuss")?.done,
    true,
    "没有决策项/种子 = 没有要拍板的，不该卡住",
  );
  assert.equal(flow.currentKey, "agent", "before 事项已完成、agent 进行中 → 当前是 agent 节点");
});

test("runStatus 映射：review/done 都算 agent 节点完成；评审节点只在 done 完成", () => {
  const review = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: true,
    runStatus: "review",
  });
  assert.equal(review.nodes.find((n) => n.kind === "agent")?.done, true);
  assert.equal(review.nodes.find((n) => n.kind === "review")?.done, false);
  assert.equal(review.currentKey, "review");
  const done = buildStepFlow({
    step: step({}),
    states: [],
    hasDraft: true,
    runStatus: "done",
  });
  assert.equal(done.currentKey, null, "全部完成时无当前节点");
});

test("after 事项未完成时卡在 after 节点（评审之前）", () => {
  const flow = buildStepFlow({
    step: step({}),
    states: [ht({ title: "下载付费", timing: "after" })],
    hasDraft: true,
    runStatus: "review",
  });
  assert.equal(flow.currentKey, "human:下载付费");
});

test("决策项未拍板完：discuss 节点不算完成，即使草稿已存在", () => {
  const s = step({
    discussionSeeds: [],
    decisions: [
      { q: "综述角度怎么收", options: ["领域全景铺开", "聚焦子问题"] },
      { q: "纳入标准定多严", options: ["只要顶刊", "含预印本"] },
    ],
  });
  // 只答了一条：草稿已存在，但还剩 1 件没拍板
  const partial = buildStepFlow({
    step: s,
    states: [],
    hasDraft: true,
    runStatus: "pending",
    pendingDecisions: 1,
  });
  const d1 = partial.nodes.find((n) => n.key === "discuss")!;
  assert.equal(d1.done, false, "还有没答的题就不该打勾");
  assert.match(d1.label, /还有 1 件要拍板/);
  assert.equal(partial.currentKey, "discuss", "当前节点应停在定方向");

  // 全部拍板完
  const all = buildStepFlow({
    step: s,
    states: [],
    hasDraft: true,
    runStatus: "pending",
    pendingDecisions: 0,
  });
  assert.equal(all.nodes.find((n) => n.key === "discuss")!.done, true);
  assert.equal(all.currentKey, "agent", "定方向做完，当前节点推进到 agent");
});

test("只有决策项、没有讨论种子：discuss 节点照常出现", () => {
  const flow = buildStepFlow({
    step: step({
      discussionSeeds: [],
      decisions: [{ q: "算力怎么排", options: ["本机跑", "上集群"] }],
    }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
    pendingDecisions: 1,
  });
  assert.ok(flow.nodes.some((n) => n.key === "discuss"));
});

test("既无决策项也无种子：discuss 节点仍在（想法区的落点），且直接算完成不挡后面", () => {
  const flow = buildStepFlow({
    step: step({ discussionSeeds: [], decisions: [] }),
    states: [],
    hasDraft: false,
    runStatus: "pending",
  });
  const d = flow.nodes.find((n) => n.key === "discuss");
  assert.ok(d, "想法区挂在这个节点上，没有它那些步骤就记不了想法");
  assert.equal(d.done, true, "没有可拍板项就不该卡住流程");
  assert.equal(flow.currentKey, "agent");
});
