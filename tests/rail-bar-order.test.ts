import assert from "node:assert/strict";
import test from "node:test";
import { moveRailBarItem, parseRailBarOrder, RAIL_BAR_DEFAULT_ORDER } from "../src/rail-bar-order.ts";

test("侧栏底部图标顺序：没存过 / 坏值回默认", () => {
  assert.deepEqual(parseRailBarOrder(null), [...RAIL_BAR_DEFAULT_ORDER]);
  assert.deepEqual(parseRailBarOrder("{oops"), [...RAIL_BAR_DEFAULT_ORDER]);
  assert.deepEqual(parseRailBarOrder('{"a":1}'), [...RAIL_BAR_DEFAULT_ORDER]);
});

test("侧栏底部图标顺序：认不出的丢掉、重复去掉、缺的按默认顺序补在后面", () => {
  assert.deepEqual(parseRailBarOrder('["stats","gone","stats",3,"skills"]'), [
    "stats",
    "skills",
    "profiles",
    "settings",
    "mcp",
  ]);
});

test("侧栏底部图标顺序：挪位其余顺移，越界原样", () => {
  const base = ["a", "b", "c", "d"];
  assert.deepEqual(moveRailBarItem(base, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveRailBarItem(base, 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveRailBarItem(base, 1, 9), base);
  assert.deepEqual(base, ["a", "b", "c", "d"], "不改原数组");
});
