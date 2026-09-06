import assert from "node:assert/strict";
import test from "node:test";
import { confirmKeyAction } from "../src/confirm-dialog.ts";

test("确认框：Esc 一律取消", () => {
  assert.equal(
    confirmKeyAction({
      key: "Escape",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "cancel",
  );
  assert.equal(
    confirmKeyAction({
      key: "Escape",
      alert: true,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "cancel",
  );
});

test("确认框：Enter 在取消钮上取消，否则确认", () => {
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: true,
      enterBlocked: false,
    }),
    "cancel",
  );
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "confirm",
  );
});

test("确认框：单按钮提示 Enter 确认；组词中的 Enter 忽略", () => {
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: true,
      focusedIsCancel: false,
      enterBlocked: false,
    }),
    "confirm",
  );
  assert.equal(
    confirmKeyAction({
      key: "Enter",
      alert: false,
      focusedIsCancel: false,
      enterBlocked: true,
    }),
    "none",
  );
});
