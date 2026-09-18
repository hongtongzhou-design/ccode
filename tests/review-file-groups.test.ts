import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFileGroup,
  groupDeliveryFiles,
  sortDeliveryPaths,
} from "../src/review-file-groups.ts";

test("精读与写作改动按笔记/稿件/引文分组", () => {
  assert.equal(deliveryFileGroup("notes/001-a.md"), "notes");
  assert.equal(deliveryFileGroup("notes/index.json"), "index");
  assert.equal(deliveryFileGroup("references.bib"), "index");
  assert.equal(deliveryFileGroup("outline.md"), "manuscript");
  assert.equal(deliveryFileGroup("manuscript/draft.md"), "manuscript");
  assert.equal(deliveryFileGroup("papers/to-fetch.md"), "fetch");
  assert.equal(deliveryFileGroup("scripts/build.py"), "machine");
  assert.equal(deliveryFileGroup("papers/a.pdf"), "other");

  const paths = [
    "scripts/x.py",
    "references.bib",
    "notes/index.json",
    "notes/002.md",
    "manuscript/draft.md",
    "papers/to-fetch.md",
  ];
  assert.deepEqual(sortDeliveryPaths(paths), [
    "notes/002.md",
    "manuscript/draft.md",
    "notes/index.json",
    "references.bib",
    "papers/to-fetch.md",
    "scripts/x.py",
  ]);
  assert.deepEqual(
    groupDeliveryFiles(paths.map((path) => ({ path }))).map((g) => g.id),
    ["notes", "manuscript", "index", "fetch", "machine"],
  );
});
