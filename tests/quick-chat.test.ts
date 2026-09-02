import assert from "node:assert/strict";
import test from "node:test";
import {
  isScratchCwd,
  pickQuickChatHistory,
  pickQuickChatSessions,
  sessionHomeLabel,
  sessionDisplayTitle,
  sidebarLaunchesDirect,
  withLiveSessionFlags,
} from "../src/quick-chat.ts";
import type { SessionMetaDto } from "../src/types.ts";

function session(over: Partial<SessionMetaDto>): SessionMetaDto {
  return {
    agent: "claude-code",
    sessionId: "s-x",
    projectPath: "/repo/sub",
    title: "标题",
    createdAt: null,
    updatedAt: null,
    filePath: "/f",
    tokenUsage: null,
    cliVersion: null,
    pinned: false,
    archived: false,
    customTitle: null,
    tags: [],
    alive: true,
    chainCount: 1,
    workspace: null,
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

const SCRATCH = "/Users/u/ccode/scratch";

test("随手聊历史：按顺序取前 N 条", () => {
  const list = Array.from({ length: 12 }, (_, i) =>
    session({ sessionId: `s-${i}`, projectPath: SCRATCH }),
  );
  const out = pickQuickChatSessions(list, [], 8);
  assert.equal(out.length, 8);
  assert.equal(out[0].sessionId, "s-0");
  assert.equal(out[7].sessionId, "s-7");
});

test("随手聊历史：排除归档/内部/live/源文件已删的（这些都恢复不了）", () => {
  const out = pickQuickChatSessions(
    [
      session({ sessionId: "s-archived", archived: true }),
      session({ sessionId: "s-internal", internal: true }),
      session({ sessionId: "s-live", live: true }),
      session({ sessionId: "s-gone", alive: false }),
      session({ sessionId: "s-ok", projectPath: SCRATCH }),
    ],
    [],
    8,
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-ok"],
  );
});

test("归属标注：工作区会话显工作区名，否则目录尾段", () => {
  assert.equal(
    sessionHomeLabel(session({ workspace: "lit-search" })),
    "⛁ lit-search",
  );
  assert.equal(sessionHomeLabel(session({ projectPath: "/repo/sub" })), "sub");
  assert.equal(
    sessionHomeLabel(session({ projectPath: "/repo/sub/" })),
    "sub",
    "尾斜杠不影响",
  );
});

test("标题优先级：自定义 > 会话标题 > 摘要 > 兜底", () => {
  assert.equal(
    sessionDisplayTitle(session({ customTitle: "改过的", title: "原标题" })),
    "改过的",
  );
  assert.equal(sessionDisplayTitle(session({ title: "原标题" })), "原标题");
  assert.equal(
    sessionDisplayTitle(session({ title: null, summary: "AI 摘要" })),
    "AI 摘要",
  );
  assert.equal(
    sessionDisplayTitle(session({ title: null, summary: null })),
    "未命名对话",
  );
});

test("随手聊历史：只列 scratch，排除工作区/已注册项目/其他仓库", () => {
  const out = pickQuickChatSessions(
    [
      session({ sessionId: "s-scratch", projectPath: SCRATCH }),
      session({
        sessionId: "s-ccode",
        projectPath: "/Users/u/Documents/Ccode",
      }),
      session({ sessionId: "s-ws", workspace: "lit-search", projectPath: SCRATCH }),
      session({
        sessionId: "s-project",
        projectPath: "/Users/u/papers/proj",
      }),
      session({ sessionId: "s-loose", projectPath: "/tmp/elsewhere" }),
    ],
    ["/Users/u/papers/proj/"],
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-scratch"],
    "未注册的编码仓库、工作区、项目内会话都不算随手聊",
  );
});

test("isScratchCwd 认家目录下 ccode/scratch，含子路径；Windows 折叠大小写", () => {
  assert.equal(isScratchCwd("/Users/u/ccode/scratch"), true);
  assert.equal(isScratchCwd("/Users/u/ccode/scratch/notes"), true);
  assert.equal(isScratchCwd("/Users/u/Documents/Ccode"), false);
  assert.equal(isScratchCwd("C:\\Users\\u\\ccode\\scratch", true), true);
  assert.equal(isScratchCwd("c:/users/u/ccode/scratch", true), true);
});

test("sidebarLaunchesDirect：记住过且没勾每次都问才直达", () => {
  assert.equal(
    sidebarLaunchesDirect({ hasRemembered: true, alwaysAsk: false }),
    true,
  );
  assert.equal(
    sidebarLaunchesDirect({ hasRemembered: true, alwaysAsk: true }),
    false,
  );
  assert.equal(
    sidebarLaunchesDirect({ hasRemembered: false, alwaysAsk: false }),
    false,
  );
});

test("withLiveSessionFlags：终端页正在跑的会话补标 live", () => {
  const listed = session({ sessionId: "s-run", live: false });
  const out = withLiveSessionFlags([listed], {
    "claude-code\ns-run": "tab-1",
  });
  assert.equal(out[0].live, true);
  assert.equal(listed.live, false, "不改入参");
});

test("pickQuickChatHistory：正在跑的随手聊不进列表", () => {
  const out = pickQuickChatHistory(
    [
      session({ sessionId: "s-live", projectPath: SCRATCH, live: false }),
      session({ sessionId: "s-ok", projectPath: SCRATCH }),
    ],
    [],
    { "claude-code\ns-live": "tab-1" },
  );
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["s-ok"],
  );
});
