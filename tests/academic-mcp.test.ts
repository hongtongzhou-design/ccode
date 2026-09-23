import assert from "node:assert/strict";
import test from "node:test";
import {
  ACADEMIC_MCP_PRESETS,
  academicMcpLoginPrompt,
  isAcademicMcpTaskTitle,
} from "../src/academic-mcp.ts";

test("学术检索 MCP 事项按标题认，可选前缀也能认", () => {
  assert.equal(isAcademicMcpTaskTitle("配置学术检索 MCP"), true);
  assert.equal(isAcademicMcpTaskTitle("（可选）配置学术检索 MCP"), true);
  assert.equal(isAcademicMcpTaskTitle("下载付费墙文献全文"), false);
});

test("预设入口：Consensus 密钥、Undermind OAuth", () => {
  assert.equal(ACADEMIC_MCP_PRESETS[0]?.label, "Consensus");
  assert.equal(ACADEMIC_MCP_PRESETS[0]?.auth, "env");
  assert.equal(ACADEMIC_MCP_PRESETS[0]?.what.includes("同行评议"), true);
  assert.equal(ACADEMIC_MCP_PRESETS[1]?.label, "Undermind");
  assert.equal(ACADEMIC_MCP_PRESETS[1]?.auth, "oauth");
  assert.equal(ACADEMIC_MCP_PRESETS[1]?.what.includes("语义"), true);
});

test("学术检索登录态只带是否就绪和一句现状", () => {
  const ready = { ready: true, note: "" };
  const missing = { ready: false, note: "Undermind 未登录" };
  assert.equal(ready.ready, true);
  assert.equal(ready.note, "");
  assert.equal(missing.ready, false);
  assert.match(missing.note, /未登录/);
});

test("去终端登录：按 Agent 给出 mcp login 命令，并要求新开会话", () => {
  assert.match(academicMcpLoginPrompt("codex"), /codex mcp login undermind/);
  assert.match(academicMcpLoginPrompt("claude-code"), /claude mcp login undermind/);
  assert.match(academicMcpLoginPrompt("codex"), /新开/);
  assert.match(academicMcpLoginPrompt(null), /codex mcp login undermind/);
});
