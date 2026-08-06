import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunOverview,
  cwdBasename,
  itemRank,
  type RunOverviewInput,
} from "../src/run-overview.ts";

function input(partial: Partial<RunOverviewInput>): RunOverviewInput {
  return {
    tabId: "t1",
    title: "终端",
    agentId: "claude-code",
    model: "",
    cwd: "/repo/proj",
    running: false,
    shell: false,
    attention: null,
    ...partial,
  };
}

test("cwdBasename 取路径尾段，容忍尾部分隔符与 Windows 分隔符", () => {
  assert.equal(cwdBasename("/repo/proj"), "proj");
  assert.equal(cwdBasename("/repo/proj/"), "proj");
  assert.equal(cwdBasename("C:\\repo\\proj"), "proj");
  assert.equal(cwdBasename("/repo/ccode/workspaces/lit-notes"), "lit-notes");
  assert.equal(cwdBasename("~"), "~");
  assert.equal(cwdBasename(""), "");
});

test("itemRank 优先级：待确认 > 已完成(未查看) > 工作中 > 其余运行中 > shell/已退出", () => {
  assert.equal(itemRank(input({ attention: "confirm", running: true }), false), 0);
  assert.equal(itemRank(input({ attention: "done", running: true }), false), 1);
  assert.equal(itemRank(input({ attention: "done", running: true }), true), 3);
  assert.equal(itemRank(input({ attention: "working", running: true }), false), 2);
  assert.equal(itemRank(input({ running: true }), false), 3);
  assert.equal(itemRank(input({ shell: true }), false), 4);
  assert.equal(itemRank(input({}), false), 4);
});

test("buildRunOverview 按「要你管」排序，同级保持标签原顺序", () => {
  const { items } = buildRunOverview(
    [
      input({ tabId: "idle" }),
      input({ tabId: "shell", shell: true }),
      input({ tabId: "work", running: true, attention: "working" }),
      input({ tabId: "done", running: true, attention: "done" }),
      input({ tabId: "confirm", running: true, attention: "confirm" }),
      input({ tabId: "run", running: true }),
    ],
    new Set(),
  );
  assert.deepEqual(
    items.map((i) => i.tabId),
    ["confirm", "done", "work", "run", "idle", "shell"],
  );
});

test("buildRunOverview 摘要只计未查看的已完成；已查看后退出「要你管」", () => {
  const inputs = [
    input({ tabId: "c1", running: true, attention: "confirm" }),
    input({ tabId: "c2", running: true, attention: "confirm" }),
    input({ tabId: "d1", running: true, attention: "done" }),
    input({ tabId: "d2", running: true, attention: "done" }),
    input({ tabId: "w1", running: true, attention: "working" }),
  ];
  const before = buildRunOverview(inputs, new Set());
  assert.deepEqual(before.summary, { confirm: 2, done: 2, working: 1 });

  const after = buildRunOverview(inputs, new Set(["d1"]));
  assert.deepEqual(after.summary, { confirm: 2, done: 1, working: 1 });
  const d1 = after.items.find((i) => i.tabId === "d1")!;
  assert.equal(d1.seenDone, true);
  assert.equal(d1.rank, 3); // 已查看的已完成落到「其余运行中」一档
  // 未查看的 d2 仍排在其前
  assert.ok(
    after.items.findIndex((i) => i.tabId === "d2") <
      after.items.findIndex((i) => i.tabId === "d1"),
  );
});

test("buildRunOverview 非 done 状态的 seen 集合条目不影响结果", () => {
  const { items, summary } = buildRunOverview(
    [input({ tabId: "w1", running: true, attention: "working" })],
    new Set(["w1"]),
  );
  assert.equal(items[0].seenDone, false);
  assert.deepEqual(summary, { confirm: 0, done: 0, working: 1 });
});
