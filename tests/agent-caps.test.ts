import assert from "node:assert/strict";
import test from "node:test";
import { headlessWriteBlocked, headlessWriteNote } from "../src/agent-caps.ts";

test("headlessWriteBlocked：不支持才禁选", () => {
  assert.equal(headlessWriteBlocked(undefined), null);
  assert.equal(headlessWriteBlocked({ supported: true }), null);
  assert.equal(
    headlessWriteBlocked({ supported: false, reason: "无头写盘未验证，定时任务请换别家" }),
    "无头写盘未验证，定时任务请换别家",
  );
  assert.equal(headlessWriteBlocked({ supported: false }), "不能用于定时任务");
});

test("headlessWriteNote：支持时仍可附注无沙箱", () => {
  assert.equal(headlessWriteNote({ supported: true }), null);
  assert.equal(
    headlessWriteNote({ supported: true, reason: "无沙箱（--yolo 全放行）" }),
    "无沙箱（--yolo 全放行）",
  );
  assert.equal(
    headlessWriteNote({ supported: false, reason: "无头写盘未验证" }),
    null,
  );
});
