import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFolderTree,
  countTreeFiles,
  fileDirKey,
  folderFoldStorageKey,
  parseExpandedFolders,
  serializeExpandedFolders,
  treeHasFolders,
} from "../src/folder-groups.ts";

test("相对路径取父目录，可剥 papers/ notes/", () => {
  assert.equal(fileDirKey("价格.xlsx"), null);
  assert.equal(fileDirKey("./价格.xlsx"), null);
  assert.equal(fileDirKey("财务/价格.xlsx"), "财务");
  assert.equal(fileDirKey("a\\b\\价格.xlsx"), "a/b");
  assert.equal(fileDirKey("papers/a.pdf", "papers"), null);
  assert.equal(fileDirKey("papers/综述/a.pdf", "papers"), "综述");
  assert.equal(fileDirKey("notes/课题A/01-x.md", "notes"), "课题A");
  assert.equal(fileDirKey("notes/01-x.md", "notes"), null);
});

test("分级树：本层文件与子文件夹并列，剥默认目录后不再套一层", () => {
  const items = [
    { rel: "AI4Paper/图文指引/Step1.png", name: "Step1.png" },
    { rel: "AI4Paper/效果演示/演示1.png", name: "演示1.png" },
    { rel: "AI4Paper/AI4Paper.md", name: "AI4Paper.md" },
    { rel: "Bob/图文指引/Step1.png", name: "Step1.png" },
    { rel: "Bob.md", name: "Bob.md" },
  ];
  const tree = buildFolderTree(items, (x) => x.rel);
  assert.equal(treeHasFolders(tree), true);
  assert.deepEqual(tree.files.map((f) => f.name), ["Bob.md"]);
  assert.deepEqual(tree.folders.map((f) => f.name), ["AI4Paper", "Bob"]);
  const a4 = tree.folders.find((f) => f.name === "AI4Paper")!;
  assert.deepEqual(a4.files.map((f) => f.name), ["AI4Paper.md"]);
  assert.deepEqual(
    new Set(a4.folders.map((f) => f.name)),
    new Set(["图文指引", "效果演示"]),
  );
  assert.equal(countTreeFiles(a4), 3);
  const flat = buildFolderTree(
    [{ rel: "papers/a.pdf" }, { rel: "papers/b.pdf" }],
    (x) => x.rel,
    "papers",
  );
  assert.equal(treeHasFolders(flat), false);
  assert.equal(flat.files.length, 2);
});

test("展开夹的存储键按项目路径，坏数据当全部收起", () => {
  assert.equal(
    folderFoldStorageKey("office:/Users/me/proj/"),
    "ccode.folderFold.office:/Users/me/proj",
  );
  assert.deepEqual([...parseExpandedFolders(null)], []);
  assert.deepEqual([...parseExpandedFolders("{")], []);
  assert.deepEqual([...parseExpandedFolders('["图文指引",""]')], ["图文指引"]);
  const round = parseExpandedFolders(
    serializeExpandedFolders(new Set(["AI4Paper", "图文指引"])),
  );
  assert.equal(round.has("AI4Paper"), true);
  assert.equal(round.has("图文指引"), true);
  assert.equal(round.size, 2);
});
