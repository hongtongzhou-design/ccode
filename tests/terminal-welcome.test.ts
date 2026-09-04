import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalIdle,
  welcomeCwdActionLabel,
  welcomeCwdLine,
  welcomeCwdShown,
} from "../src/terminal-welcome.ts";

test("无 PTY 或尚未上报都算未启动", () => {
  assert.equal(isTerminalIdle(null), true);
  assert.equal(isTerminalIdle(undefined), true);
  assert.equal(isTerminalIdle({ ptyId: null }), true);
  assert.equal(isTerminalIdle({ ptyId: "" }), true);
  assert.equal(isTerminalIdle({ ptyId: "pty-1" }), false);
});

test("空态目录短名：空串和裸 ~ 都显示 ~，家目录折 ~", () => {
  assert.equal(welcomeCwdShown("", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("  ", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("~", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("/Users/me", "/Users/me"), "~");
  assert.equal(welcomeCwdShown("/Users/me/src", "/Users/me"), "~/src");
  assert.equal(welcomeCwdShown("/opt/app", "/Users/me"), "/opt/app");
  assert.equal(welcomeCwdShown("/Users/me/src", ""), "/Users/me/src");
  assert.equal(
    welcomeCwdShown("C:\\Users\\me\\proj", "C:\\Users\\me", true),
    "~/proj",
  );
});

test("空态目录行：启动与恢复各一句", () => {
  assert.equal(
    welcomeCwdActionLabel("/Users/me", "/Users/me", false),
    "将在 ~ 启动",
  );
  assert.equal(
    welcomeCwdActionLabel("/Users/me/src", "/Users/me", true),
    "将在 ~/src 恢复",
  );
  assert.equal(
    welcomeCwdLine("/Users/me", "/Users/me", "开始"),
    "将在 ~ 开始",
  );
});
