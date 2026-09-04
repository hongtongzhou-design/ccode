import assert from "node:assert/strict";
import test from "node:test";
import { MAC_TRAFFIC_PAD, macOverlayPadClass } from "../src/mac-titlebar.ts";

test("窗口态 Mac 给红绿灯让位；全屏或非 Mac 用闲时边距", () => {
  assert.equal(macOverlayPadClass(true, false, "pl-3"), MAC_TRAFFIC_PAD);
  assert.equal(macOverlayPadClass(true, true, "pl-3"), "pl-3");
  assert.equal(macOverlayPadClass(false, false, "pl-3"), "pl-3");
  assert.equal(macOverlayPadClass(false, true, "pl-2"), "pl-2");
});
