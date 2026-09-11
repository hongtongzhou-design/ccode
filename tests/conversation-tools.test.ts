import assert from "node:assert/strict";
import test from "node:test";
import {
  groupConversationSegments,
  isAlertToolMessage,
  isProcessBlock,
  isToolOnlyAssistant,
  processFoldLabel,
  segmentContainsIndex,
  toolCallCount,
} from "../src/conversation-tools.ts";
import type { BlockDto, ChatMessageDto } from "../src/types.ts";

function msg(
  role: string,
  blocks: BlockDto[],
): ChatMessageDto {
  return { role, blocks, timestamp: null, usage: null };
}

function tool(name: string): BlockDto {
  return { kind: "tool_use", text: "{}", toolName: name };
}

function result(text: string): BlockDto {
  return { kind: "tool_result", text, toolName: null };
}

function text(body: string): BlockDto {
  return { kind: "text", text: body, toolName: null };
}

test("只有工具块的助手消息才可合并", () => {
  assert.equal(isToolOnlyAssistant(msg("assistant", [tool("Read")])), true);
  assert.equal(
    isToolOnlyAssistant(msg("assistant", [tool("Read"), result("ok")])),
    true,
  );
  assert.equal(
    isToolOnlyAssistant(msg("assistant", [tool("Read"), text("看完了")])),
    false,
  );
  assert.equal(isToolOnlyAssistant(msg("user", [tool("Read")])), false);
});

test("权限拒绝和中断单独露出", () => {
  assert.equal(
    isAlertToolMessage(msg("assistant", [result("permission denied")])),
    true,
  );
  assert.equal(
    isAlertToolMessage(msg("assistant", [text("请求已中断")])),
    true,
  );
  assert.equal(
    isAlertToolMessage(msg("assistant", [result("file contents")])),
    false,
  );
});

test("连续纯工具消息合成一条执行记录，正文和告警切开", () => {
  const messages = [
    msg("user", [text("改这一处")]),
    msg("assistant", [tool("Read"), result("a")]),
    msg("assistant", [tool("Edit"), result("b")]),
    msg("assistant", [result("permission denied")]),
    msg("assistant", [text("改好了")]),
  ];
  const segs = groupConversationSegments(messages);
  assert.equal(segs.length, 4);
  assert.equal(segs[0]?.kind, "message");
  assert.equal(segs[1]?.kind, "tool-run");
  if (segs[1]?.kind === "tool-run") {
    assert.equal(segs[1].messages.length, 2);
    assert.equal(toolCallCount(segs[1].blocks), 2);
    assert.equal(segmentContainsIndex(segs[1], 1), true);
    assert.equal(segmentContainsIndex(segs[1], 2), true);
    assert.equal(segmentContainsIndex(segs[1], 3), false);
  }
  assert.equal(segs[2]?.kind, "message");
  assert.equal(segs[3]?.kind, "message");
});

test("process fold label collapses thinking and tools", () => {
  const thinking: BlockDto = { kind: "thinking", text: "…", toolName: null };
  assert.equal(isProcessBlock(thinking), true);
  assert.equal(isProcessBlock(text("正文")), false);
  assert.equal(processFoldLabel([thinking]), "思考过程");
  assert.equal(
    processFoldLabel([tool("Read"), result("ok")]),
    "执行记录 · 1 次工具调用",
  );
  assert.equal(
    processFoldLabel([thinking, tool("Bash"), result("ok")]),
    "过程 · 思考与 1 次工具调用",
  );
});
