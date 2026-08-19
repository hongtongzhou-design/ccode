import assert from "node:assert/strict";
import test from "node:test";
import { clampTabDragDx, tabDragTarget } from "../src/tab-drag.ts";

// 等宽三槽（130px + 4px gap）：left 0 / 134 / 268
const SLOTS = [
  { left: 0, width: 130 },
  { left: 134, width: 130 },
  { left: 268, width: 130 },
];

test("目标槽位：源中心越过谁的中线就占谁的位", () => {
  // 拖第一个：不过槽1中线（199）归 0，过了归 1，过槽2中线（333）归 2
  assert.equal(tabDragTarget(SLOTS, 0, 0), 0);
  assert.equal(tabDragTarget(SLOTS, 0, 100), 0); // cx=165 < 199
  assert.equal(tabDragTarget(SLOTS, 0, 140), 1); // cx=205 > 199
  assert.equal(tabDragTarget(SLOTS, 0, 270), 2); // cx=335 > 333
  // 拖最后一个往左：过槽1中线归 1，再左归 0
  assert.equal(tabDragTarget(SLOTS, 2, 0), 2);
  assert.equal(tabDragTarget(SLOTS, 2, -100), 1); // cx=233 < 333, > 199
  assert.equal(tabDragTarget(SLOTS, 2, -260), 0); // cx=73 < 199
});

test("回归：只有两个标签时左拖右到底必须让位（钳制上限 = 末槽中线，>= 才够得着）", () => {
  const two = [SLOTS[0], SLOTS[1]];
  const dx = clampTabDragDx(two, 0, 9999);
  // 钳制上限 = 源右缘到末槽右缘 = 134；此时 cx = 65+134 = 199 = 槽1中线
  assert.equal(dx, 134);
  assert.equal(tabDragTarget(two, 0, dx), 1, "严格 > 会在这里永远得到 0");
});

test("回归：多标签拖到最右一个同样够得着", () => {
  const dx = clampTabDragDx(SLOTS, 0, 9999);
  assert.equal(dx, 268);
  assert.equal(tabDragTarget(SLOTS, 0, dx), 2);
});

test("钳制：源标签不出内容范围（首槽左缘 / 末槽右缘）", () => {
  assert.equal(clampTabDragDx(SLOTS, 0, -50), 0, "首标签左拖原地不动");
  assert.equal(clampTabDragDx(SLOTS, 2, -9999), -268, "末标签左缘到首槽左缘");
  assert.equal(clampTabDragDx(SLOTS, 1, -9999), -134);
  assert.equal(clampTabDragDx(SLOTS, 1, 9999), 134);
  assert.equal(clampTabDragDx([], 0, 100), 0);
});

test("钳制后的极值位置目标判定不越界", () => {
  for (let from = 0; from < SLOTS.length; from++) {
    const lo = clampTabDragDx(SLOTS, from, -9999);
    const hi = clampTabDragDx(SLOTS, from, 9999);
    assert.equal(tabDragTarget(SLOTS, from, lo), 0);
    assert.equal(tabDragTarget(SLOTS, from, hi), SLOTS.length - 1);
  }
});
