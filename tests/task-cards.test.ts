import assert from "node:assert/strict";
import test from "node:test";
import {
  briefSourcesForStep,
  briefTimeFromPath,
  bucketCardsByStep,
  cardForStep,
  checkedBriefRefs,
  defaultCheckedSources,
  groupSessionsByTask,
  taskMdEditorReduce,
  latestBrief,
  sortCards,
} from "../src/task-cards.ts";
import type { TaskCardDto } from "../src/types.ts";

function card(partial: Partial<TaskCardDto>): TaskCardDto {
  return {
    id: "t-1",
    name: "卡片",
    step: null,
    workspace: null,
    createdAt: "2026-08-01T10:00:00Z",
    briefs: [],
    ...partial,
  };
}

test("sortCards：创建时间升序，同刻按名称兜底", () => {
  const sorted = sortCards([
    card({ id: "t-b", name: "乙", createdAt: "2026-08-02T00:00:00Z" }),
    card({ id: "t-a2", name: "甲二", createdAt: "2026-08-01T00:00:00Z" }),
    card({ id: "t-a1", name: "甲一", createdAt: "2026-08-01T00:00:00Z" }),
  ]);
  assert.deepEqual(
    sorted.map((c) => c.id),
    ["t-a1", "t-a2", "t-b"],
  );
});

test("bucketCardsByStep：步骤桶按流水线顺序；失效步骤的卡并入未挂步骤桶（末尾）", () => {
  const buckets = bucketCardsByStep(
    [
      card({ id: "t-2", name: "二", step: "写综述" }),
      card({ id: "t-1", name: "一", step: "读文献" }),
      card({ id: "t-3", name: "散卡" }),
      card({ id: "t-4", name: "旧步骤卡", step: "已删除步骤" }),
    ],
    ["读文献", "写综述", "空步骤"],
  );
  assert.deepEqual(
    buckets.map((b) => [b.step, b.cards.map((c) => c.id)]),
    [
      ["读文献", ["t-1"]],
      ["写综述", ["t-2"]],
      ["空步骤", []],
      [null, ["t-3", "t-4"]],
    ],
  );
});

test("latestBrief：时间序末位为最新；空简报返回 null", () => {
  assert.equal(latestBrief(card({})), null);
  assert.equal(
    latestBrief(
      card({
        briefs: [".ccode/brief-20260801T100000Z.md", ".ccode/brief-20260802T100000Z.md"],
      }),
    ),
    ".ccode/brief-20260802T100000Z.md",
  );
});

test("cardForStep：取挂该步骤的第一张卡（创建序）；无则 null", () => {
  const cards = [
    card({ id: "t-new", name: "晚建", step: "写作", createdAt: "2026-08-03T00:00:00Z" }),
    card({ id: "t-old", name: "早建", step: "写作", createdAt: "2026-08-01T00:00:00Z" }),
    card({ id: "t-other", name: "别步", step: "读文献" }),
  ];
  assert.equal(cardForStep(cards, "写作")?.id, "t-old");
  assert.equal(cardForStep(cards, "不存在"), null);
});

test("briefTimeFromPath：解析落盘时间戳，同秒后缀与脏名兜底", () => {
  assert.equal(
    briefTimeFromPath(".ccode/brief-20260811T094721Z.md"),
    "2026-08-11T09:47:21Z",
  );
  assert.equal(
    briefTimeFromPath(".ccode/brief-20260811T094721Z-2.md"),
    "2026-08-11T09:47:21Z",
  );
  assert.equal(briefTimeFromPath(".ccode/brief-改名了.md"), null);
  assert.equal(briefTimeFromPath(".ccode/brief-20261399T999999Z.md"), null);
});

test("groupSessionsByTask：未归置恒在最前，组按最近活跃降序，组内保持传入顺序", () => {
  type S = { taskId: string | null; taskName: string | null; updatedAt: string | null; id: string };
  const s = (p: Partial<S> & { id: string }): S => ({
    taskId: null,
    taskName: null,
    updatedAt: null,
    ...p,
  });
  const groups = groupSessionsByTask([
    s({ id: "a1", taskId: "t-a", taskName: "卡A", updatedAt: "2026-08-02T00:00:00Z" }),
    s({ id: "free", updatedAt: "2026-08-05T00:00:00Z" }),
    s({ id: "b1", taskId: "t-b", taskName: "卡B", updatedAt: "2026-08-04T00:00:00Z" }),
    s({ id: "a2", taskId: "t-a", taskName: "卡A", updatedAt: "2026-08-01T00:00:00Z" }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.name, g.list.map((x) => x.id)]),
    [
      ["未归置", ["free"]],
      ["卡B", ["b1"]],
      ["卡A", ["a1", "a2"]],
    ],
  );
});

test("groupSessionsByTask：卡片已删除（taskName 为 null）回落「未命名卡片」，不报错", () => {
  const groups = groupSessionsByTask([
    { taskId: "t-gone", taskName: null, updatedAt: "2026-08-01T00:00:00Z" },
  ]);
  assert.equal(groups[0].name, "未命名卡片");
});

test("briefSourcesForStep：只收挂该步骤且含简报的卡，取最新简报与时间", () => {
  const cards = [
    card({ id: "t-1", name: "一", step: "写作", briefs: [".ccode/brief-20260801T100000Z.md", ".ccode/brief-20260802T100000Z.md"] }),
    card({ id: "t-2", name: "二", step: "写作" }),
    card({ id: "t-3", name: "三", step: "读文献", briefs: [".ccode/brief-20260803T100000Z.md"] }),
  ];
  const sources = briefSourcesForStep(cards, "写作", ["写作", "读文献"]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].card.id, "t-1");
  assert.equal(sources[0].brief, ".ccode/brief-20260802T100000Z.md");
  assert.equal(sources[0].time, "2026-08-02T10:00:00Z");
});

test("defaultCheckedSources：出处卡优先；否则唯一有简报的卡；多张无出处不勾", () => {
  const cards = [
    card({ id: "t-a", name: "甲", step: "写作", briefs: [".ccode/brief-20260801T100000Z.md"], createdAt: "2026-08-01T00:00:00Z" }),
    card({ id: "t-b", name: "乙", step: "写作", briefs: [".ccode/brief-20260802T100000Z.md"], createdAt: "2026-08-02T00:00:00Z" }),
  ];
  const sources = briefSourcesForStep(cards, "写作", ["写作", "读文献"]);
  // 出处卡（哪怕不是最新）优先
  assert.deepEqual([...defaultCheckedSources(sources, "t-a")], ["t-a"]);
  // 多张且无出处：不勾（保持原步进器开工无简报口径）
  assert.deepEqual([...defaultCheckedSources(sources, null)], []);
  // 唯一有简报的卡：默认勾上
  const single = briefSourcesForStep([cards[0]], "写作", ["写作"]);
  assert.deepEqual([...defaultCheckedSources(single, null)], ["t-a"]);
  // 出处卡没有简报（不在来源里）：回落唯一卡
  assert.deepEqual([...defaultCheckedSources(single, "t-gone")], ["t-a"]);
});

test("checkedBriefRefs：按卡片排序序输出勾选子集", () => {
  const cards = [
    card({ id: "t-b", name: "乙", step: "写作", briefs: [".ccode/brief-20260802T100000Z.md"], createdAt: "2026-08-02T00:00:00Z" }),
    card({ id: "t-a", name: "甲", step: "写作", briefs: [".ccode/brief-20260801T100000Z.md"], createdAt: "2026-08-01T00:00:00Z" }),
  ];
  const sources = briefSourcesForStep(cards, "写作", ["写作", "读文献"]);
  assert.deepEqual(checkedBriefRefs(sources, new Set(["t-b", "t-a"])), [
    { path: ".ccode/brief-20260801T100000Z.md", cardName: "甲" },
    { path: ".ccode/brief-20260802T100000Z.md", cardName: "乙" },
  ]);
  assert.deepEqual(checkedBriefRefs(sources, new Set()), []);
});

test("briefSourcesForStep：未挂步骤与步骤改名失效的卡也入来源范围", () => {
  const cards = [
    card({ id: "t-1", name: "本步", step: "写作", createdAt: "2026-08-01T00:00:00Z", briefs: [".ccode/brief-20260801T100000Z.md"] }),
    card({ id: "t-2", name: "散卡", step: null, createdAt: "2026-08-02T00:00:00Z", briefs: [".ccode/brief-20260802T100000Z.md"] }),
    card({ id: "t-3", name: "旧步骤卡", step: "已改名步骤", createdAt: "2026-08-03T00:00:00Z", briefs: [".ccode/brief-20260803T100000Z.md"] }),
    card({ id: "t-4", name: "别步卡", step: "读文献", createdAt: "2026-08-04T00:00:00Z", briefs: [".ccode/brief-20260804T100000Z.md"] }),
  ];
  const sources = briefSourcesForStep(cards, "写作", ["写作", "读文献"]);
  assert.deepEqual(sources.map((s) => s.card.id), ["t-1", "t-2", "t-3"]);
});

test("taskMdEditorReduce：脏态防覆盖，重置恢复跟随拼装", () => {
  let st = { text: "", dirty: false };
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v1" });
  assert.deepEqual(st, { text: "默认v1", dirty: false });
  // 未脏：勾选变化的重拼跟随
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v2" });
  assert.equal(st.text, "默认v2");
  // 人编辑后 dirty：重拼/再加载不覆盖
  st = taskMdEditorReduce(st, { type: "edit", text: "人改的" });
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v3" });
  assert.equal(st.text, "人改的");
  // AI 融合填入也算脏
  st = taskMdEditorReduce(st, { type: "fused", text: "AI 融合稿" });
  assert.deepEqual(st, { text: "AI 融合稿", dirty: true });
  // 恢复默认拼装：回到跟随态
  st = taskMdEditorReduce(st, { type: "reset", text: "默认v4" });
  st = taskMdEditorReduce(st, { type: "assemble", text: "默认v5" });
  assert.deepEqual(st, { text: "默认v5", dirty: false });
});
