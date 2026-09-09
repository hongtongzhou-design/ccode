import assert from "node:assert/strict";
import test from "node:test";
import { previewSaveCompletion } from "../src/file-preview.ts";

test("预览保存完成：只将提交给后端的内容视为磁盘基线", () => {
  const result = previewSaveCompletion("已提交", "保存时继续输入", "revision-2");
  assert.equal(result.snapshot.text, "已提交");
  assert.equal(result.snapshot.revision, "revision-2");
  assert.equal(result.dirty, true);
});

test("预览保存完成：内容未变化时才清除 dirty", () => {
  assert.equal(previewSaveCompletion("内容", "内容", "rev").dirty, false);
});
