import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBlenderMcpProbe,
  applyMcpPreset,
  expandHomeToken,
  joinUnderHome,
  MCP_PRESETS,
  writableMcpAgentIds,
} from "../src/mcp-presets.ts";

function preset(name: string) {
  const p = MCP_PRESETS.find((x) => x.name === name);
  assert.ok(p, `缺少预设 ${name}`);
  return p;
}

test("内置预设含 Consensus / Undermind / Blender", () => {
  assert.equal(preset("consensus").kind, "remote");
  assert.equal(preset("undermind").kind, "remote");
  assert.equal(preset("blender").kind, "stdio");
  assert.equal(preset("blender").command, "uv");
  assert.ok(preset("blender").setup);
});

test("joinUnderHome 三平台分隔符", () => {
  assert.equal(
    joinUnderHome("/Users/alice", "blender_mcp/mcp", false),
    "/Users/alice/blender_mcp/mcp",
  );
  assert.equal(
    joinUnderHome("C:\\Users\\alice", "blender_mcp/mcp", true),
    "C:\\Users\\alice\\blender_mcp\\mcp",
  );
});

test("expandHomeToken 只替换 {home} 路径、不改 URL 斜杠", () => {
  const cmd =
    'git clone https://projects.blender.org/lab/blender_mcp.git "{home}/blender_mcp"';
  assert.equal(
    expandHomeToken(cmd, "/Users/alice", false),
    'git clone https://projects.blender.org/lab/blender_mcp.git "/Users/alice/blender_mcp"',
  );
  assert.equal(
    expandHomeToken(cmd, "C:\\Users\\alice", true),
    'git clone https://projects.blender.org/lab/blender_mcp.git "C:\\Users\\alice\\blender_mcp"',
  );
});

test("Blender 预设展开后命令指向家目录仓库", () => {
  const applied = applyMcpPreset(preset("blender"), "/Users/alice", false);
  assert.equal(applied.command, "uv");
  assert.deepEqual(applied.args, [
    "--directory",
    "/Users/alice/blender_mcp/mcp",
    "run",
    "--with",
    "mcp<2",
    "blender-mcp",
  ]);
  assert.equal(applied.startupTimeoutMs, 30_000);
  assert.ok(applied.setup);
  const clone = applied.setup.steps.find((s) => s.command?.includes("git clone"));
  assert.ok(clone?.command?.includes("/Users/alice/blender_mcp"));
  assert.ok(clone.command?.includes("https://projects.blender.org/lab/blender_mcp.git"));
});

test("Blender 预设 Windows 走反斜杠家目录，不用 C:\\blender_mcp", () => {
  const applied = applyMcpPreset(preset("blender"), "C:\\Users\\bob", true);
  assert.equal(applied.args[1], "C:\\Users\\bob\\blender_mcp\\mcp");
  assert.ok(!applied.args.some((a) => /^C:\\blender_mcp/i.test(a)));
  assert.ok(applied.setup);
  assert.ok(!applied.setup.steps.some((s) => s.command?.includes("curl")));
  assert.ok(applied.setup.steps.some((s) => s.href?.includes("astral.sh")));
});

test("Blender 探测把已完成步骤打勾，查不到的保持未做", () => {
  const applied = applyMcpPreset(preset("blender"), "/Users/alice", false);
  assert.ok(applied.setup);
  const marked = applyBlenderMcpProbe(applied.setup, {
    blender: { status: "ok", detail: "5.1 · /Applications/Blender.app" },
    addon: { status: "missing" },
    uv: { status: "ok", detail: "/opt/homebrew/bin/uv" },
    repo: { status: "missing" },
    running: { status: "missing", detail: "默认端口 9876 未在听" },
  });
  assert.equal(marked.steps.find((s) => s.id === "blender")?.status, "done");
  assert.equal(marked.steps.find((s) => s.id === "uv")?.status, "done");
  assert.equal(marked.steps.find((s) => s.id === "addon")?.status, "todo");
  assert.equal(marked.steps.find((s) => s.id === "repo")?.status, "todo");
  assert.equal(marked.steps.find((s) => s.id === "running")?.status, "todo");
  assert.equal(marked.progress, "已检测到 2/5 项就绪。");
});

test("Blender 过旧标警告，不全就绪不说可以直接保存", () => {
  const applied = applyMcpPreset(preset("blender"), "/Users/alice", false);
  assert.ok(applied.setup);
  const marked = applyBlenderMcpProbe(applied.setup, {
    blender: { status: "too_old", detail: "找到 Blender 4.5" },
    addon: { status: "ok" },
    uv: { status: "ok" },
    repo: { status: "ok" },
    running: { status: "ok" },
  });
  assert.equal(marked.steps.find((s) => s.id === "blender")?.status, "warn");
  assert.match(marked.progress ?? "", /4\/5/);
});

test("从预设启用只开 MCP 可写的 agent", () => {
  const ids = writableMcpAgentIds(
    ["claude", "codex", "grok"],
    {
      claude: { mcpWrite: { supported: true } },
      grok: { mcpWrite: { supported: false } },
    },
  );
  assert.deepEqual(ids, ["claude"]);
});

test("remote 预设不依赖家目录、不带 stdio 命令", () => {
  const applied = applyMcpPreset(preset("consensus"), "", false);
  assert.equal(applied.kind, "remote");
  assert.equal(applied.command, "");
  assert.equal(applied.args.length, 0);
  assert.equal(applied.url, "https://mcp.consensus.app/mcp");
  assert.equal(applied.setup, null);
});
