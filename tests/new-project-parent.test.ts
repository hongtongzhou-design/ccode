import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudSyncHint,
  loadNewProjectParent,
  NEW_PROJECT_PARENT_KEY,
  saveNewProjectParent,
} from "../src/new-project-parent.ts";

function withStorage(fn: (store: Map<string, string>) => void) {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    fn(store);
  } finally {
    g.localStorage = prev;
  }
}

test("新建项目位置：记住上次用的上级文件夹，空值不记", () => {
  withStorage((store) => {
    assert.equal(loadNewProjectParent(), null);
    saveNewProjectParent("  ");
    assert.equal(store.has(NEW_PROJECT_PARENT_KEY), false);
    saveNewProjectParent("/Volumes/盘/Research");
    assert.equal(loadNewProjectParent(), "/Volumes/盘/Research");
  });
});

test("没有 localStorage 时不抛错，回落由后端处理", () => {
  const g = globalThis as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = undefined;
  try {
    assert.equal(loadNewProjectParent(), null);
    saveNewProjectParent("/x");
  } finally {
    g.localStorage = prev;
  }
});

test("同步盘提醒：只在认出网盘时给，文案点名是哪家", () => {
  assert.equal(cloudSyncHint(null), null);
  assert.equal(cloudSyncHint(""), null);
  assert.match(cloudSyncHint("iCloud") ?? "", /会被 iCloud 同步/);
});
