import assert from "node:assert/strict";
import test from "node:test";
import { isHtmlPath, isMarkdownPath } from "../src/md-path.ts";

test("isMarkdownPath 覆盖 md/markdown/mdx/qmd，大小写不敏感", () => {
  assert.equal(isMarkdownPath("notes/a.md"), true);
  assert.equal(isMarkdownPath("README.markdown"), true);
  assert.equal(isMarkdownPath("manuscript/main.qmd"), true);
  assert.equal(isMarkdownPath("src/App.mdx"), true);
  assert.equal(isMarkdownPath("Notes/DRAFT.MD"), true);
  assert.equal(isMarkdownPath("src/main.rs"), false);
  assert.equal(isMarkdownPath("index.html"), false);
});

test("isHtmlPath 只认 html/htm", () => {
  assert.equal(isHtmlPath("output/paper.html"), true);
  assert.equal(isHtmlPath("index.HTM"), true);
  assert.equal(isHtmlPath("notes/a.md"), false);
});
