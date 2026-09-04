import assert from "node:assert/strict";
import test from "node:test";
import {
  groupLanesByTheme,
  laneActivityLabel,
  lastLaneTheme,
  overlayLanes,
} from "../src/coding-lanes.ts";

const trees = [
  { path: "/repo", branch: "main", isPrimary: true },
  { path: "/wt/ui", branch: "feature/login-ui", isPrimary: false },
  { path: "/wt/api", branch: "feature/login-api", isPrimary: false },
];

test("overlayLanes：无行时按分支名现算", () => {
  const rows = overlayLanes(trees, [], false);
  assert.equal(rows[1]?.lane.name, "feature/login-ui");
  assert.equal(rows[1]?.lane.theme, null);
});

test("groupLanesByTheme：主仓单独一组，主题分组", () => {
  const rows = overlayLanes(
    trees,
    [
      {
        id: "1",
        name: "前端",
        theme: "登录",
        branch: "feature/login-ui",
        worktreePath: "/wt/ui",
      },
      {
        id: "2",
        name: "后端",
        theme: "登录",
        branch: "feature/login-api",
        worktreePath: "/wt/api",
      },
    ],
    false,
  );
  const groups = groupLanesByTheme(rows);
  assert.equal(groups[0]?.label, "主仓");
  assert.equal(groups[1]?.label, "登录");
  assert.equal(groups[1]?.items.length, 2);
});

test("lastLaneTheme 取最后一条非空主题", () => {
  assert.equal(lastLaneTheme([{ theme: null }, { theme: "登录" }]), "登录");
  assert.equal(lastLaneTheme([]), "");
});

test("laneActivityLabel：树上有活 Agent 才不是空闲", () => {
  assert.equal(
    laneActivityLabel("/wt/ui", [
      { cwd: "/wt/ui", agentId: "codex", running: true, attention: "working" },
    ]),
    "codex",
  );
  assert.equal(
    laneActivityLabel("/wt/ui", [
      { cwd: "/wt/other", agentId: "codex", running: true },
    ]),
    "空闲",
  );
});
