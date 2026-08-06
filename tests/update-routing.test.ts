import assert from "node:assert/strict";
import test from "node:test";
import { interactiveUpdatePrefill } from "../src/update-routing.ts";

test("交互式 TUI 自更新：命中时返回终端预填命令", () => {
  // kimi 自装（~/.kimi-code/bin）的更新检查结果
  assert.equal(
    interactiveUpdatePrefill({
      interactiveTui: true,
      interactiveUpdateCommand: "kimi upgrade",
    }),
    "kimi upgrade",
  );
});

test("普通渠道（brew/npm/非交互自更新）不路由：返回 null 走原更新流程", () => {
  assert.equal(
    interactiveUpdatePrefill({
      interactiveTui: false,
      interactiveUpdateCommand: null,
    }),
    null,
  );
  assert.equal(interactiveUpdatePrefill({}), null);
  assert.equal(interactiveUpdatePrefill(undefined), null);
});

test("标记与命令不齐时不路由（防御后端数据缺失，退回原更新流程）", () => {
  assert.equal(
    interactiveUpdatePrefill({
      interactiveTui: true,
      interactiveUpdateCommand: null,
    }),
    null,
  );
  assert.equal(
    interactiveUpdatePrefill({ interactiveTui: true, interactiveUpdateCommand: "  " }),
    null,
  );
});
