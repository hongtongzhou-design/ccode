import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeShellPath,
  joinDroppedPaths,
  firstImageItem,
  imageExtFromMime,
  pasteImageFeedback,
  shouldReportTerminalColors,
  xtermOscColorReport,
} from "../src/terminal-input.ts";

test("escapeShellPath 安全字符路径原样返回", () => {
  assert.equal(escapeShellPath("/tmp/a.png"), "/tmp/a.png");
  // 非 ASCII（中文名）不在安全字符集内：保守包裹（各 shell 对单引号内 UTF-8 都安全）
  assert.equal(escapeShellPath("/Users/u/截图-1.png"), "'/Users/u/截图-1.png'");
});

test("escapeShellPath 含空格/引号/反斜杠整体单引号包裹", () => {
  assert.equal(escapeShellPath("/tmp/my pic.png"), "'/tmp/my pic.png'");
  assert.equal(escapeShellPath("C:\\Users\\a b\\x.png"), "'C:\\Users\\a b\\x.png'");
  assert.equal(escapeShellPath("it's.png"), "'it'\\''s.png'");
});

test("joinDroppedPaths 多路径转义后空格拼接", () => {
  assert.equal(
    joinDroppedPaths(["/tmp/a.png", "/tmp/b c.png", "/tmp/d'e.txt"]),
    "/tmp/a.png '/tmp/b c.png' '/tmp/d'\\''e.txt'",
  );
  assert.equal(joinDroppedPaths([]), "");
  assert.equal(joinDroppedPaths(["/tmp/a.png", ""]), "/tmp/a.png");
});

test("firstImageItem 挑出第一个 image/* 条目", () => {
  assert.equal(
    firstImageItem([{ type: "text/plain" }, { type: "image/png" }]),
    1,
  );
  assert.equal(firstImageItem([{ type: "text/plain" }]), -1);
  assert.equal(
    firstImageItem([{ type: "image/png" }, { type: "image/jpeg" }]),
    0,
  );
});

test("imageExtFromMime 白名单映射与兜底 png", () => {
  assert.equal(imageExtFromMime("image/png"), "png");
  assert.equal(imageExtFromMime("image/jpeg"), "jpg");
  assert.equal(imageExtFromMime("image/gif"), "gif");
  assert.equal(imageExtFromMime("image/webp"), "webp");
  assert.equal(imageExtFromMime("image/bmp"), "png");
  assert.equal(imageExtFromMime("IMAGE/JPEG"), "jpg");
});

test("pasteImageFeedback 长文件名截断", () => {
  assert.equal(
    pasteImageFeedback("/cfg/ccode/tmp/paste-20260817-110000-ab12.png"),
    "已粘贴图片路径：paste-20260817-110000-ab12.png",
  );
  const long = `/tmp/${"x".repeat(60)}.png`;
  const out = pasteImageFeedback(long);
  assert.ok(out.startsWith("已粘贴图片路径："), out);
  assert.ok(out.endsWith("…"), out);
});

test("xtermOscColorReport 生成 Agent TUI 可识别的 16-bit RGB 回报", () => {
  // 每个 8-bit 通道复制一份成 16-bit：gemini 的 OSC_11_REGEX 与 codex 的探测都按这个格式解析
  assert.equal(
    xtermOscColorReport(11, "#fdfdfe"),
    "\x1b]11;rgb:fdfd/fdfd/fefe\x1b\\",
  );
  assert.equal(
    xtermOscColorReport(10, "#3a3f52"),
    "\x1b]10;rgb:3a3a/3f3f/5252\x1b\\",
  );
  assert.equal(
    xtermOscColorReport(11, " #FFFFFF "),
    "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
  );
  // 非 #rrggbb（如 transparent / rgba）没法回报，返回 null 由调用方跳过
  assert.equal(xtermOscColorReport(11, "transparent"), null);
});

const reportOpts = (over: Partial<Parameters<typeof shouldReportTerminalColors>[0]> = {}) => ({
  isWindows: true,
  kind: "agent" as const,
  agentId: "gemini",
  themeId: "midnight-light",
  enabled: true,
  ...over,
});

test("底色告知只在 Windows + 探测型 agent + 浅色 + 开关开启时发生", () => {
  assert.equal(shouldReportTerminalColors(reportOpts()), true);
  // macOS/Linux 的 xterm.js 会如实应答 OSC 查询，不需要主动推
  assert.equal(shouldReportTerminalColors(reportOpts({ isWindows: false })), false);
  // 普通 shell 不探测底色，推了只会变成输入框里的乱码
  assert.equal(shouldReportTerminalColors(reportOpts({ kind: "shell" })), false);
  // 深色本就是 agent 探测失败的回落值，推了没收益
  assert.equal(shouldReportTerminalColors(reportOpts({ themeId: "midnight" })), false);
  assert.equal(shouldReportTerminalColors(reportOpts({ themeId: undefined })), false);
  assert.equal(shouldReportTerminalColors(reportOpts({ enabled: false })), false);
});

test("只推给会消费 OSC 11 回报的 agent，其余一律不推", () => {
  // 实测会探测并消费：gemini（TerminalCapabilityManager）、qwen（detectOsc11Theme）
  for (const id of ["gemini", "qwen"]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ agentId: id })), true, id);
  }
  // codex 0.150.1 已无底色探测，推过去会漏进输入框变乱码（2026-08-29 实机回归）；
  // claude-code 走 settings.json theme、同样不探测
  for (const id of ["codex", "claude-code", "cursor", "kimi", "opencode", "codebuddy", "grok"]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ agentId: id })), false, id);
  }
  assert.equal(shouldReportTerminalColors(reportOpts({ agentId: undefined })), false);
});

test("七套浅色主题都会触发底色告知", () => {
  for (const id of [
    "midnight-light",
    "terracotta-light",
    "ayu-light",
    "mocha-light",
    "neutral-light",
    "dracula-light",
    "shadcn-light",
  ]) {
    assert.equal(shouldReportTerminalColors(reportOpts({ themeId: id })), true, id);
  }
});
