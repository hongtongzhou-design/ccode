import test from "node:test";
import assert from "node:assert/strict";
import {
  ancestorDirsToReveal,
  fileMatchesProjectFilter,
  flattenVisibleFiles,
  neighborFile,
  artifactPreviewSurface,
  projectFilePreviewKind,
} from "../src/project-files.ts";

test("research and coding files preview in-pane, including source", () => {
  assert.equal(projectFilePreviewKind("notes/a.md"), "text");
  assert.equal(projectFilePreviewKind("src/main.rs"), "text");
  assert.equal(projectFilePreviewKind("app.tsx"), "text");
  assert.equal(projectFilePreviewKind("Cargo.toml"), "text");
  assert.equal(projectFilePreviewKind("papers/a.pdf"), "pdf");
  assert.equal(projectFilePreviewKind("fig.png"), "image");
  assert.equal(projectFilePreviewKind("data.xlsx"), "xlsx");
  assert.equal(projectFilePreviewKind("data.csv"), "xlsx");
  assert.equal(projectFilePreviewKind("data.tsv"), "xlsx");
  assert.equal(projectFilePreviewKind("draft.docx"), "docx");
  assert.equal(projectFilePreviewKind("old.doc"), "legacy-doc");
});

test("产物核验：pdf/docx 就地预览，不跳运行页", () => {
  assert.equal(artifactPreviewSurface("output/draft.pdf"), "media");
  assert.equal(artifactPreviewSurface("output/draft.docx"), "media");
  assert.equal(artifactPreviewSurface("figures/fig1.png"), "media");
  assert.equal(artifactPreviewSurface("manuscript/draft.md"), "text");
  assert.equal(artifactPreviewSurface("papers/to-fetch.ris"), "text");
  assert.equal(artifactPreviewSurface("main.bin"), "jump");
});

test("type filter keeps original office categories", () => {
  assert.equal(fileMatchesProjectFilter("a.md", "all"), true);
  assert.equal(fileMatchesProjectFilter("a.rs", "all"), true);
  assert.equal(fileMatchesProjectFilter("a.md", "doc"), true);
  assert.equal(fileMatchesProjectFilter("a.rs", "doc"), false);
  assert.equal(fileMatchesProjectFilter("a.pdf", "pdf"), true);
  assert.equal(fileMatchesProjectFilter("a.xlsx", "sheet"), true);
  assert.equal(fileMatchesProjectFilter("a.pptx", "slide"), true);
});

test("flattenVisibleFiles only walks expanded directories", () => {
  const cache = {
    "/p": [
      { path: "/p/a.md", isDir: false },
      { path: "/p/src", isDir: true },
    ],
    "/p/src": [{ path: "/p/src/main.rs", isDir: false }],
  };
  assert.deepEqual(
    flattenVisibleFiles(cache, "/p", new Set()).map((item) => item.path),
    ["/p/a.md"],
  );
  assert.deepEqual(
    flattenVisibleFiles(cache, "/p", new Set(["/p/src"])).map((item) => item.path),
    ["/p/a.md", "/p/src/main.rs"],
  );
});

test("neighborFile steps to previous and next, and stops at ends", () => {
  const files = [{ path: "a" }, { path: "b" }, { path: "c" }];
  assert.equal(neighborFile(files, "b", 1)?.path, "c");
  assert.equal(neighborFile(files, "b", -1)?.path, "a");
  assert.equal(neighborFile(files, "a", -1), null);
  assert.equal(neighborFile(files, "c", 1), null);
  assert.equal(neighborFile(files, null, 1)?.path, "a");
});

test("ancestorDirsToReveal：展开到文件所在目录，不含根", () => {
  assert.deepEqual(ancestorDirsToReveal("/p", "/p/papers/a.pdf"), ["/p/papers"]);
  assert.deepEqual(ancestorDirsToReveal("/p", "/p/a.pdf"), []);
  assert.deepEqual(ancestorDirsToReveal("/p", "/other/a.pdf"), []);
  assert.deepEqual(
    ancestorDirsToReveal("C:\\p", "C:\\p\\papers\\a.pdf", true),
    ["C:\\p\\papers"],
  );
});
