import assert from "node:assert/strict";
import test from "node:test";
import {
  attributeToProject,
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

test("itemRank 优先级：待确认 > 工作中 > 其余运行中 > shell/已退出；已回复不占档", () => {
  assert.equal(itemRank(input({ attention: "confirm", running: true })), 0);
  assert.equal(itemRank(input({ attention: "working", running: true })), 1);
  // done = 回合结束，不阻塞决策，随 running 归普通档
  assert.equal(itemRank(input({ attention: "done", running: true })), 2);
  assert.equal(itemRank(input({ attention: "done" })), 3);
  assert.equal(itemRank(input({ running: true })), 2);
  assert.equal(itemRank(input({ shell: true })), 3);
  assert.equal(itemRank(input({})), 3);
});

test("buildRunOverview 按「要你管」排序，同级保持标签原顺序", () => {
  const { items } = buildRunOverview([
    input({ tabId: "idle" }),
    input({ tabId: "shell", shell: true }),
    input({ tabId: "work", running: true, attention: "working" }),
    input({ tabId: "done", running: true, attention: "done" }),
    input({ tabId: "confirm", running: true, attention: "confirm" }),
    input({ tabId: "run", running: true }),
  ]);
  assert.deepEqual(
    items.map((i) => i.tabId),
    ["confirm", "work", "done", "run", "idle", "shell"],
  );
});

test("buildRunOverview 摘要不计已回复", () => {
  const { summary } = buildRunOverview([
    input({ tabId: "c1", running: true, attention: "confirm" }),
    input({ tabId: "c2", running: true, attention: "confirm" }),
    input({ tabId: "d1", running: true, attention: "done" }),
    input({ tabId: "w1", running: true, attention: "working" }),
  ]);
  assert.deepEqual(summary, { confirm: 2, working: 1 });
});

test("attributeToProject 最长前缀命中 + 段边界", () => {
  const groups = [
    { key: "p:a", roots: ["/repo/a", "/repo/a-ws/lit"] },
    { key: "p:b", roots: ["/repo/b"] },
  ];
  // 工作树内路径归到该项目（roots 含 worktreePath）
  assert.equal(attributeToProject("/repo/a-ws/lit/notes", groups), "p:a");
  // 项目根本身命中
  assert.equal(attributeToProject("/repo/b", groups), "p:b");
  // 段边界：/repo/a2 不得误中 /repo/a
  assert.equal(
    attributeToProject("/repo/a2/x", [{ key: "p:a", roots: ["/repo/a"] }]),
    null,
  );
  // 嵌套根取最长前缀
  assert.equal(
    attributeToProject("/repo/a/sub/deep", [
      { key: "outer", roots: ["/repo/a"] },
      { key: "inner", roots: ["/repo/a/sub"] },
    ]),
    "inner",
  );
  // Windows 分隔符归一 + 尾部斜杠
  assert.equal(
    attributeToProject("C:\\repo\\a\\sub", [{ key: "p:a", roots: ["C:/repo/a/"] }]),
    "p:a",
  );
  // 不命中 / 空路径
  assert.equal(attributeToProject("/elsewhere", groups), null);
  assert.equal(attributeToProject("", groups), null);
});
