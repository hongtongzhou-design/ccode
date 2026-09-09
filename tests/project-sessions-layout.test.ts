import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_SESSIONS_OPEN_KEY,
  PROJECT_SESSIONS_OVERLAY_MAX_PX,
  readProjectSessionsOpen,
  shouldOverlayProjectSessions,
  writeProjectSessionsOpen,
} from "../src/project-sessions-layout.ts";

test("缺省与非法值都当作对话栏开着", () => {
  assert.equal(readProjectSessionsOpen(null), true);
  assert.equal(readProjectSessionsOpen({ getItem: () => null }), true);
  assert.equal(readProjectSessionsOpen({ getItem: () => "maybe" }), true);
});

test("1/0 读写", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  writeProjectSessionsOpen(false, storage);
  assert.equal(store.get(PROJECT_SESSIONS_OPEN_KEY), "0");
  assert.equal(readProjectSessionsOpen(storage), false);
  writeProjectSessionsOpen(true, storage);
  assert.equal(store.get(PROJECT_SESSIONS_OPEN_KEY), "1");
  assert.equal(readProjectSessionsOpen(storage), true);
});

test("主区窄于 56rem 才改抽屉", () => {
  assert.equal(PROJECT_SESSIONS_OVERLAY_MAX_PX, 896);
  assert.equal(shouldOverlayProjectSessions(895), true);
  assert.equal(shouldOverlayProjectSessions(896), false);
  assert.equal(shouldOverlayProjectSessions(1280), false);
});
