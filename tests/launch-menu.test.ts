import assert from "node:assert/strict";
import test from "node:test";
import { placeDownMenu } from "../src/launch-menu.ts";

test("锚点在窗口顶部时菜单从下沿往下长", () => {
  const box = placeDownMenu(
    { left: 16, bottom: 48, width: 144 },
    { width: 1200, height: 800 },
    220,
  );
  assert.equal(box.top, 52);
  assert.ok(box.top > 48);
  assert.equal(box.left, 16);
  assert.equal(box.width, 220);
  assert.equal(box.maxHeight, 320);
});

test("贴右缘时整单向左挪，仍不抬到锚点上方", () => {
  const box = placeDownMenu(
    { left: 1100, bottom: 48, width: 140 },
    { width: 1200, height: 800 },
    220,
  );
  assert.equal(box.top, 52);
  assert.ok(box.left + box.width <= 1200 - 8);
  assert.ok(box.left >= 8);
});

test("下方空间不够时只缩短高度", () => {
  const box = placeDownMenu(
    { left: 16, bottom: 700, width: 144 },
    { width: 1200, height: 760 },
    220,
  );
  assert.equal(box.top, 704);
  assert.equal(box.maxHeight, 760 - 704 - 8);
  assert.ok(box.maxHeight < 320);
});
