import assert from "node:assert/strict";
import test from "node:test";
import { caretOfAttention, closeAsksFirst, quietStoppedSessions, strongestCaret, withUnread } from "../src/run-caret.ts";

test("一个开着的 Agent：等确认 / 干活照注意力，做完了或还不知道按闲着", () => {
  assert.equal(caretOfAttention("confirm"), "confirm");
  assert.equal(caretOfAttention("working"), "working");
  assert.equal(caretOfAttention("done"), "idle");
  assert.equal(caretOfAttention(null), "idle");
});

test("几个合成一个：等确认 > 干活 > 闲着，空的没有", () => {
  assert.equal(strongestCaret(["idle", "working", "idle"]), "working");
  assert.equal(strongestCaret(["working", "confirm"]), "confirm");
  assert.equal(strongestCaret(["idle", null]), "idle");
  assert.equal(strongestCaret([]), null);
  assert.equal(strongestCaret([null, undefined]), null);
});

test("关掉开着的对话：只有明确回完话的直接关，干活 / 等确认 / 还不知道都先问", () => {
  assert.equal(closeAsksFirst("done"), false);
  assert.equal(closeAsksFirst("working"), true);
  assert.equal(closeAsksFirst("confirm"), true);
  assert.equal(closeAsksFirst(null), true);
  assert.equal(closeAsksFirst(undefined), true);
});

test("做完了没看：闲着或进程已收掉换成蓝光标，又在干活 / 等确认时照旧", () => {
  assert.equal(withUnread("idle", true), "unread");
  assert.equal(withUnread(null, true), "unread");
  assert.equal(withUnread("working", true), "working");
  assert.equal(withUnread("confirm", true), "confirm");
  assert.equal(withUnread("idle", false), "idle");
  assert.equal(withUnread(null, false), null);
});

test("几个合成一个时没看的排在干活前面、等确认后面", () => {
  assert.equal(strongestCaret(["working", "unread", "idle"]), "unread");
  assert.equal(strongestCaret(["unread", "confirm"]), "confirm");
});

test("quietStoppedSessions：Mesa 停下之后没再写过的熄掉，之后又写过的照亮，没变化原样返回（2026-10-31）", () => {
  const at = Date.parse("2026-10-31T14:27:40Z");
  const s = (sessionId: string, updatedAt: string, live = true) => ({ agent: "claude-code", sessionId, live, updatedAt });
  const stopped = new Map([["claude-code\na", at], ["claude-code\nb", at]]);
  const list = [s("a", "2026-10-31T14:27:34Z"), s("b", "2026-10-31T14:28:30Z"), s("c", "2026-10-31T14:27:34Z")];
  const out = quietStoppedSessions(list, stopped);
  assert.deepEqual(out.map((x) => x.live), [false, true, true]);
  const calm = [s("c", "2026-10-31T14:27:34Z"), s("a", "2026-10-31T14:27:34Z", false)];
  assert.equal(quietStoppedSessions(calm, stopped), calm);
});
