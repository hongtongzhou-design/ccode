import assert from "node:assert/strict";
import test from "node:test";
import { fileTypeIcon } from "../src/file-icons.ts";

test("常见类型命中固定识别色标签", () => {
  assert.deepEqual(fileTypeIcon("docs/guide.md"), {
    label: "M↓",
    color: "#5ca861",
  });
  assert.deepEqual(fileTypeIcon("src/App.tsx"), {
    label: "⚛",
    color: "#61dafb",
  });
  assert.deepEqual(fileTypeIcon("src/store.ts"), {
    label: "TS",
    color: "#3178c6",
  });
  assert.deepEqual(fileTypeIcon("src-tauri/src/lib.rs"), {
    label: "R",
    color: "#dea584",
  });
});

test("扩展名大小写不敏感，qmd 归入口记 markdown 图标", () => {
  assert.equal(fileTypeIcon("Notes/DRAFT.MD")?.label, "M↓");
  assert.equal(fileTypeIcon("manuscript/main.qmd")?.label, "M↓");
});

test("Windows 反斜杠路径与无扩展名/未知类型的兜底", () => {
  assert.equal(fileTypeIcon("src\\components\\GitPanel.tsx")?.label, "⚛");
  assert.equal(fileTypeIcon("Makefile"), null);
  assert.equal(fileTypeIcon(".gitignore"), null);
  assert.equal(fileTypeIcon("archive.tar.unknownext"), null);
});
