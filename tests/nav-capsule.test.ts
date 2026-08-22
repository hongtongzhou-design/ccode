import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS,
  NAV_CAPSULE_DELAYS,
  isNavCapsuleItemVisible,
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
  assert.deepEqual(NAV_CAPSULE_DELAYS, [500, 1000, 2000, 5000]);
  assert.equal(normalizeNavCapsuleDelay(500), 500);
  assert.equal(normalizeNavCapsuleDelay(999), 1000);
  assert.equal(normalizeNavCapsuleDelay("2000"), 1000);
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
