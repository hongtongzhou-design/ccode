import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS,
  INITIAL_NAV_ISLAND,
  NAV_CAPSULE_DELAYS,
  isIslandExpanded,
  isNavCapsuleItemVisible,
  reconcileIsland,
  cycleBrandState,
  enterChromeHidden,
  exitChromeHidden,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  normalizeNavCapsuleDelay,
  resolveStartupNavMode,
  toggleChromeHiddenState,
} from "../src/nav-capsule.ts";

test("brand button toggles expanded ↔ collapsed without entering hidden", () => {
  const expanded = {
    navCollapsed: false,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
  const collapsed = cycleBrandState(expanded);
  assert.deepEqual(collapsed, { ...expanded, navCollapsed: true });
  assert.deepEqual(cycleBrandState(collapsed), expanded);
  assert.equal(cycleBrandState(collapsed).chromeHidden, false);
});

test("direct hidden toggle snapshots expanded state too", () => {
  const state = {
    navCollapsed: false,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
  const hidden = toggleChromeHiddenState(state);
  assert.equal(hidden.chromeHidden, true);
  assert.equal(hidden.chromeHiddenReturnCollapsed, false);
  assert.deepEqual(toggleChromeHiddenState(hidden), state);
});

test("startup mode respects legacy preference when absent", () => {
  assert.equal(resolveStartupNavMode(undefined, false), "expanded");
  assert.equal(resolveStartupNavMode(undefined, true), "collapsed");
  assert.equal(resolveStartupNavMode("hidden", false), "hidden");
  assert.equal(resolveStartupNavMode("unknown", true), "collapsed");
});

test("capsule delay accepts only supported values", () => {
  assert.deepEqual(NAV_CAPSULE_DELAYS, [0, 500, 1000, 2000, 5000]);
  assert.equal(normalizeNavCapsuleDelay(0), 0);
  assert.equal(normalizeNavCapsuleDelay(500), 500);
  assert.equal(normalizeNavCapsuleDelay(999), 1000);
  assert.equal(normalizeNavCapsuleDelay("2000"), 1000);
  // 未设置与非法值都落到 1 秒，不会因为 0 是可选项而把"没配"读成"立即"
  assert.equal(normalizeNavCapsuleDelay(undefined), 1000);
  assert.equal(normalizeNavCapsuleDelay(null), 1000);
});

test("entering hidden twice does not overwrite restore snapshot", () => {
  const first = enterChromeHidden({
    navCollapsed: true,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  });
  assert.deepEqual(
    enterChromeHidden({ ...first, navCollapsed: false }),
    { ...first, navCollapsed: false },
  );
});

test("capsule display mode defaults to both and accepts only supported values", () => {
  assert.equal(normalizeNavCapsuleDisplayMode(undefined), "both");
  assert.equal(normalizeNavCapsuleDisplayMode("icons"), "icons");
  assert.equal(normalizeNavCapsuleDisplayMode("labels"), "labels");
  assert.equal(normalizeNavCapsuleDisplayMode("text"), "both");
});

test("capsule visible items default to all and filter unknown ids", () => {
  assert.deepEqual(
    normalizeNavCapsuleVisibleItems(undefined),
    DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS,
  );
  assert.deepEqual(
    normalizeNavCapsuleVisibleItems(["workbench", "unknown", 3, "settings"]),
    ["workbench", "settings"],
  );
  assert.deepEqual(normalizeNavCapsuleVisibleItems([]), []);
});

test("hidden current page remains temporarily visible", () => {
  assert.equal(isNavCapsuleItemVisible("workbench", "workbench", []), true);
  assert.equal(isNavCapsuleItemVisible("workbench", "settings", []), false);
  assert.equal(isNavCapsuleItemVisible("settings", "workbench", ["settings"]), true);
});

/* --- 完全隐藏侧栏时的顶部灵动岛状态机 --- */

test("island starts dormant with no transient flags", () => {
  assert.deepEqual(INITIAL_NAV_ISLAND, {
    phase: "dormant",
    pointerInside: false,
    focused: false,
  });
});

test("pointer enter and focus both expand the island", () => {
  assert.equal(reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter").phase, "expanded");
  assert.equal(reconcileIsland(INITIAL_NAV_ISLAND, "focus").phase, "expanded");
});

test("delay-expired collapses only after both pointer and focus leave", () => {
  // 悬停中到点：不收
  const hovering = reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter");
  assert.deepEqual(reconcileIsland(hovering, "delay-expired"), hovering);

  // 指针离开但焦点还在：仍不收（否则 Tab 焦点会落进被遮住的页面）
  const focused = reconcileIsland(hovering, "focus");
  const afterLeave = reconcileIsland(focused, "pointer-leave");
  assert.equal(afterLeave.phase, "expanded");
  assert.equal(reconcileIsland(afterLeave, "delay-expired").phase, "expanded");

  // 两者都离开：收起
  const blur = reconcileIsland(afterLeave, "blur");
  assert.equal(reconcileIsland(blur, "delay-expired").phase, "dormant");
});

test("pointer re-entry during the wait period keeps the island open", () => {
  const armed = reconcileIsland(
    reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter"),
    "pointer-leave",
  );
  // 等待期内重新指向：回到 expanded，随后的 delay-expired 不再应收
  const back = reconcileIsland(armed, "pointer-enter");
  assert.equal(back.phase, "expanded");
  assert.deepEqual(reconcileIsland(back, "delay-expired"), back);
});

test("close drops back to the initial island state immediately", () => {
  const open = reconcileIsland(
    reconcileIsland(INITIAL_NAV_ISLAND, "pointer-enter"),
    "focus",
  );
  assert.deepEqual(reconcileIsland(open, "close"), INITIAL_NAV_ISLAND);
});

test("isIslandExpanded treats focus and hover as one judgement", () => {
  assert.equal(isIslandExpanded(INITIAL_NAV_ISLAND), false);
  assert.equal(isIslandExpanded({ ...INITIAL_NAV_ISLAND, focused: true }), true);
  assert.equal(isIslandExpanded({ ...INITIAL_NAV_ISLAND, pointerInside: true }), true);
});

/* 休眠面恒带文字，不跟 displayMode 走。仅符号模式下若它也只剩图标，休眠面就退回
   「一个孤零零的光图标」——看不出是入口，也看不出悬停会展开整排导航。
   displayMode 管的是展开态那排导航项（那里是"一排"，才有符号/文字之分），
   而休眠面只有一个控件、不是一排。 */
test("休眠面恒带文字，不跟随 displayMode", () => {
  const src = readFileSync(
    new URL("../src/components/TopNavCapsule.tsx", import.meta.url),
    "utf8",
  );
  const m =
    /const restoreItem = \(interactive: boolean, collapsedFace: boolean\) => \(([\s\S]*?)\n {2}\);/.exec(
      src,
    );
  assert.ok(m, "找不到 restoreItem，可能被改名或改了签名");
  const body = m[1];

  // 休眠面走自己的字面量分支，绕开受 showIcon/showLabel 影响的 itemContent
  assert.match(body, /collapsedFace \? \(/);
  assert.match(body, /<span>恢复侧栏<\/span>/);
  // 展开面仍按模式走
  assert.match(body, /itemContent\(PanelLeftOpen, "恢复侧栏"\)/);
});

test("休眠面的按钮是一枚带字的胶囊，不是一枚方图标", () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  const restore = /\.ccode-nav-island-restore\s*\{[^}]*\}/.exec(css);
  assert.ok(restore, "找不到 .ccode-nav-island-restore 规则");
  // 带字之后 7px 横内距贴在字上会显挤，需要比导航项宽一点
  assert.match(restore[0], /padding:\s*0 9px/);
});
