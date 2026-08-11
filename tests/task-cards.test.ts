import assert from "node:assert/strict";
import test from "node:test";
import {
  briefTimeFromPath,
  bucketCardsByStep,
  cardForStep,
  groupSessionsByTask,
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
