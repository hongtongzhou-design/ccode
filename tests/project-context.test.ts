import test from "node:test";
import assert from "node:assert/strict";
import {
  composeLaunchPrompt,
  defaultContextRules,
  formatTopLevelMap,
  renderProjectContextPack,
} from "../src/project-context.ts";

test("research pack names the project, lists files, and states write-review", () => {
  const pack = renderProjectContextPack({
    name: "AI Agent 研究",
    path: "/Users/me/AI Agent 研究",
    workMode: "research",
    topic: "Agent 在软件工程中的应用",
    settings: ["引用必须可追溯"],
    topLevel: [
      { name: "papers", isDir: true },
      { name: "notes", isDir: true },
      { name: "README.md", isDir: false },
      { name: ".git", isDir: true },
    ],
    goal: "根据项目里的文献写综述",
    writeReview: true,
  });
  assert.match(pack, /AI Agent 研究/);
  assert.match(pack, /科研/);
  assert.match(pack, /papers\//);
  assert.doesNotMatch(pack, /\.git/);
  assert.match(pack, /课题主题/);
  assert.match(pack, /根据项目里的文献写综述/);
  assert.match(pack, /验收再写回/);
});

test("formatTopLevelMap caps long lists and marks empty trees", () => {
  assert.deepEqual(formatTopLevelMap([]), ["- （顶层还没有文件）"]);
  const many = Array.from({ length: 30 }, (_, index) => ({
    name: `f${index}`,
    isDir: false,
  }));
  const lines = formatTopLevelMap(many, 24);
  assert.equal(lines.length, 25);
  assert.match(lines[24], /还有 6 项/);
});

test("composeLaunchPrompt keeps pack and user text apart", () => {
  assert.equal(composeLaunchPrompt("PACK", ""), "PACK");
  assert.equal(composeLaunchPrompt("", "hello"), "hello");
  assert.equal(composeLaunchPrompt("PACK", "hello"), "PACK\n\n----\n\nhello");
});

test("coding rules warn against writing the primary tree", () => {
  assert.match(defaultContextRules("coding").join("\n"), /主仓/);
});
