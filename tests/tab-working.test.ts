import assert from "node:assert/strict";
import test from "node:test";
import {
  PTY_ECHO_SUPPRESS_MS,
  applyTailAttention,
  conversationTurnSettled,
  onPtyWorkingSilence,
  ptyInputLooksLikeSubmit,
  ptyOutputMarksWorking,
  shouldArmWorkingOnLaunch,
} from "../src/tab-working.ts";

const KIMI_ENTER = "\x1b[13u";

test("启动/恢复不点亮；只有新会话带首条指令才转圈", () => {
  assert.equal(shouldArmWorkingOnLaunch({ isResume: true, prompt: "hi" }), false);
  assert.equal(shouldArmWorkingOnLaunch({ isResume: false, prompt: "" }), false);
  assert.equal(shouldArmWorkingOnLaunch({ isResume: false, prompt: "  " }), false);
  assert.equal(shouldArmWorkingOnLaunch({ isResume: false, prompt: null }), false);
  assert.equal(shouldArmWorkingOnLaunch({ isResume: false, prompt: "hi" }), true);
});

test("ptyInputLooksLikeSubmit 认回车与 kimi CSI-u", () => {
  assert.equal(ptyInputLooksLikeSubmit("hello", KIMI_ENTER), false);
  assert.equal(ptyInputLooksLikeSubmit("hello\r", KIMI_ENTER), true);
  assert.equal(ptyInputLooksLikeSubmit("a\n", KIMI_ENTER), true);
  assert.equal(ptyInputLooksLikeSubmit(KIMI_ENTER, KIMI_ENTER), true);
});

test("交互回显窗口内不打 working", () => {
  assert.equal(
    ptyOutputMarksWorking({
      prev: null,
      armed: true,
      msSinceInteraction: PTY_ECHO_SUPPRESS_MS,
    }),
    false,
  );
  assert.equal(
    ptyOutputMarksWorking({
      prev: null,
      armed: true,
      msSinceInteraction: PTY_ECHO_SUPPRESS_MS + 1,
    }),
    true,
  );
});

test("confirm 不被 PTY 残帧改成 working", () => {
  assert.equal(
    ptyOutputMarksWorking({
      prev: "confirm",
      armed: true,
      msSinceInteraction: 1000,
    }),
    false,
  );
});

test("回合已结束且未再提交时，PTY 残帧不能从 done 点亮转圈", () => {
  assert.equal(
    ptyOutputMarksWorking({
      prev: "done",
      armed: false,
      msSinceInteraction: 5000,
    }),
    false,
  );
  assert.equal(
    ptyOutputMarksWorking({
      prev: null,
      armed: false,
      msSinceInteraction: 5000,
    }),
    false,
  );
});

test("用户刚提交后，PTY 输出可以从 done 重新打 working", () => {
  assert.equal(
    ptyOutputMarksWorking({
      prev: "done",
      armed: true,
      msSinceInteraction: 1000,
    }),
    true,
  );
});

test("已经在 working 时后续输出续命，不必再 armed", () => {
  assert.equal(
    ptyOutputMarksWorking({
      prev: "working",
      armed: false,
      msSinceInteraction: 1000,
    }),
    true,
  );
});

test("conversationTurnSettled：最后一条是助手正文才算生成完", () => {
  assert.equal(conversationTurnSettled([]), false);
  assert.equal(
    conversationTurnSettled([
      { role: "user", blocks: [{ kind: "text", text: "hi" }] },
    ]),
    false,
  );
  assert.equal(
    conversationTurnSettled([
      { role: "user", blocks: [{ kind: "text", text: "hi" }] },
      { role: "assistant", blocks: [{ kind: "text", text: "ok" }] },
    ]),
    true,
  );
  assert.equal(
    conversationTurnSettled([
      {
        role: "assistant",
        blocks: [
          { kind: "text", text: "先查一下" },
          { kind: "tool_use", text: "" },
        ],
      },
    ]),
    false,
  );
});

test("会话窗口已落完助手正文时立刻 done，不被 sticky working 续命", () => {
  assert.deepEqual(
    applyTailAttention({
      prev: "working",
      tail: "working",
      armed: true,
      turnSettled: true,
    }),
    { attention: "done", armed: false },
  );
});

test("问句收尾的 confirm 优先于会话已落盘", () => {
  assert.deepEqual(
    applyTailAttention({
      prev: "working",
      tail: "confirm",
      armed: true,
      turnSettled: true,
    }),
    { attention: "confirm", armed: false },
  );
});

test("会话尾部 done/confirm 立刻停转圈并卸武装", () => {
  assert.deepEqual(
    applyTailAttention({ prev: "working", tail: "done", armed: true }),
    { attention: "done", armed: false },
  );
  assert.deepEqual(
    applyTailAttention({ prev: "working", tail: "confirm", armed: true }),
    { attention: "confirm", armed: false },
  );
});

test("会话文件 sticky working 不得在熄灭后重新点亮", () => {
  assert.deepEqual(
    applyTailAttention({ prev: null, tail: "working", armed: false }),
    { attention: null, armed: false },
  );
  assert.deepEqual(
    applyTailAttention({ prev: "done", tail: "working", armed: false }),
    { attention: "done", armed: false },
  );
});

test("用户刚提交或仍在 working 时，尾部 working 维持转圈", () => {
  assert.deepEqual(
    applyTailAttention({ prev: null, tail: "working", armed: true }),
    { attention: "working", armed: true },
  );
  assert.deepEqual(
    applyTailAttention({ prev: "working", tail: "working", armed: false }),
    { attention: "working", armed: false },
  );
});

test("PTY 静默：等首字保持转圈，出过字则熄灭", () => {
  assert.deepEqual(
    onPtyWorkingSilence({
      prev: "working",
      armed: true,
      hadPtyWorkingOutput: false,
    }),
    { attention: "working", armed: true, clearHadOutput: false },
  );
  assert.deepEqual(
    onPtyWorkingSilence({
      prev: "working",
      armed: true,
      hadPtyWorkingOutput: true,
    }),
    { attention: null, armed: false, clearHadOutput: true },
  );
  assert.deepEqual(
    onPtyWorkingSilence({
      prev: "working",
      armed: false,
      hadPtyWorkingOutput: true,
    }),
    { attention: null, armed: false, clearHadOutput: true },
  );
});

test("启动注入等回复时，TUI 开屏算出字也不能熄灭转圈", () => {
  assert.deepEqual(
    onPtyWorkingSilence({
      prev: "working",
      armed: true,
      hadPtyWorkingOutput: true,
      pendingReply: true,
    }),
    { attention: "working", armed: true, clearHadOutput: false },
  );
});
