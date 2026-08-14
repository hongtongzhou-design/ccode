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
      "discuss:任务书：和 Agent 聊出本步任务书",
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

test("无种子步骤没有 discuss 节点；当前节点随完成推进", () => {
  const states = [ht({ title: "补文献", timing: "before", done: true })];
  const flow = buildStepFlow({
    step: step({}),
    states,
    hasDraft: false,
    runStatus: "active",
  });
  assert.deepEqual(
    flow.nodes.map((n) => n.kind),
    ["human", "agent", "review"],
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
