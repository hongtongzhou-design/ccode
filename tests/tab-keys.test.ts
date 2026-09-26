import test from "node:test";
import assert from "node:assert/strict";
import { nextTabIndex, tabNavDelta, tabStopIndex } from "../src/tab-keys.ts";

/**
 * 标签栏键盘导航的纯逻辑。
 *
 * 抽出来的理由：SegTabs 与 ProjectSurfaceTabs 两处规则本该一致，但只有前者实现了
 * 方向键与游标 tabindex；把规则写进这里再由测试钉住，避免第三处再各写各的。
 */

test("方向键认四个方向，其余键不拦截", () => {
  assert.equal(tabNavDelta("ArrowRight"), 1);
  assert.equal(tabNavDelta("ArrowDown"), 1);
  assert.equal(tabNavDelta("ArrowLeft"), -1);
  assert.equal(tabNavDelta("ArrowUp"), -1);
  // Tab / Enter / Escape 不能返回位移，否则会把焦点管理从浏览器手里抢走
  for (const key of ["Tab", "Enter", "Escape", "a", "Home", "End"]) {
    assert.equal(tabNavDelta(key), 0, `${key} 不该被当成导航键`);
  }
});

test("位移越界回卷，不留死端", () => {
  assert.equal(nextTabIndex(0, 1, 3), 1);
  assert.equal(nextTabIndex(2, 1, 3), 0, "最后一项按右键应回到第一项");
  assert.equal(nextTabIndex(0, -1, 3), 2, "第一项按左键应跳到末项");
  assert.equal(nextTabIndex(1, -1, 3), 0);
});

test("单项列表原地不动，不除零", () => {
  assert.equal(nextTabIndex(0, 1, 1), 0);
  assert.equal(nextTabIndex(0, -1, 1), 0);
});

test("空列表不抛异常（关闭中的页签集合会瞬时为空）", () => {
  assert.equal(nextTabIndex(0, 1, 0), 0);
  assert.equal(nextTabIndex(3, -1, 0), 0);
});

test("当前值不在列表里（-1）时，方向键从第一项起步", () => {
  // 项目从「无流程」切到「流程」时页签集合会变，选中项可能瞬间落空
  assert.equal(nextTabIndex(-1, 1, 3), 1);
  assert.equal(nextTabIndex(-1, -1, 3), 2);
});

test("游标 tabindex：整排只有一格可 Tab 到", () => {
  assert.equal(tabStopIndex(0, 0), 0);
  assert.equal(tabStopIndex(1, 0), -1);
  assert.equal(tabStopIndex(2, 1), -1);
  // 无选中时全为 -1，容器本身仍可聚焦，方向键能落地第一项
  assert.equal(tabStopIndex(0, -1), -1);
});
