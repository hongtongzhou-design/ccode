import assert from "node:assert/strict";
import test from "node:test";
import { pickWorkspaceResume } from "../src/workspace-resume.ts";
import type { SessionMetaDto } from "../src/types.ts";

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s-x",
    projectPath: "/repo",
    title: null,
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: false,
    chainCount: 1,
    workspace: "lit-search",
    stepName: null,
    summary: null,
    live: false,
    source: "cli",
    internal: false,
    handoffFromAgent: null,
    handoffFromSession: null,
    taskId: null,
    taskName: null,
    ...over,
  };
}

test("去终端 resume：取该工作区最近活跃的一条（列表已降序，第一个命中即最新）", () => {
  const out = pickWorkspaceResume(
    [
      session({ sessionId: "s-new", workspace: "lit-search" }),
      session({ sessionId: "s-old", workspace: "lit-search" }),
    ],
    "lit-search",
    "/repo",
  );
  assert.deepEqual(out, { agentId: "claude-code", sessionId: "s-new" });
});

test("去终端 resume：工作区名与仓库路径都要匹配（路径去尾斜杠）", () => {
  const sessions = [
    session({ sessionId: "s-other-ws", workspace: "data-eda" }),
    session({
      sessionId: "s-other-repo",
      workspace: "lit-search",
      projectPath: "/other",
    }),
    session({ sessionId: "s-hit", workspace: "lit-search" }),
  ];
  const out = pickWorkspaceResume(sessions, "lit-search", "/repo/");
  assert.equal(out?.sessionId, "s-hit");
});

test("去终端 resume：项目根会话（无 workspace）不算该工作区的", () => {
  const out = pickWorkspaceResume(
    [session({ sessionId: "s-root", workspace: null })],
    "lit-search",
    "/repo",
  );
  assert.equal(out, null);
});

test("去终端 resume：排除归档 / 内部无头 / live 中的会话", () => {
  const out = pickWorkspaceResume(
    [
      session({ sessionId: "s-archived", archived: true }),
      session({ sessionId: "s-internal", internal: true }),
      session({ sessionId: "s-live", live: true }),
      session({ sessionId: "s-ok" }),
    ],
    "lit-search",
    "/repo",
  );
  assert.equal(out?.sessionId, "s-ok");
});

test("去终端 resume：全排除或无会话时返回 null（去终端降级为新标签）", () => {
  assert.equal(pickWorkspaceResume([], "lit-search", "/repo"), null);
  assert.equal(
    pickWorkspaceResume(
      [session({ live: true })],
      "lit-search",
      "/repo",
    ),
    null,
  );
});
