import assert from "node:assert/strict";
import test from "node:test";
import { imeBlocksEnter } from "../src/ime-guard.ts";

test("组词中：isComposing 或 keyCode 229 都拦 Enter", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: true, keyCode: 13, composingLock: false }),
    true,
  );
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 229, composingLock: false }),
    true,
  );
});

test("compositionend 后一帧的锁：拦 Safari 那次确认候选的 Enter", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 13, composingLock: true }),
    true,
  );
});

test("组词已结束且无锁：普通 Enter 放行", () => {
  assert.equal(
    imeBlocksEnter({ isComposing: false, keyCode: 13, composingLock: false }),
    false,
  );
});
