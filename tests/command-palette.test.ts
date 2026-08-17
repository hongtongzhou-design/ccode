import assert from "node:assert/strict";
import test from "node:test";
import { filterCommands, type PaletteCommand } from "../src/command-palette.ts";

const COMMANDS: PaletteCommand[] = [
  { id: "page:workspaces", title: "项目", hint: "⌘1", keywords: ["workspaces"] },
  { id: "page:terminal", title: "终端", hint: "⌘2", keywords: ["terminal"] },
  { id: "theme:dracula", title: "主题：Dracula", keywords: ["theme", "主题", "dracula"] },
];

test("filterCommands 空查询返回全部且保持顺序", () => {
  assert.deepEqual(filterCommands(COMMANDS, ""), COMMANDS);
  assert.deepEqual(filterCommands(COMMANDS, "   "), COMMANDS);
});

test("filterCommands 标题中文子串命中", () => {
  const out = filterCommands(COMMANDS, "项目");
  assert.deepEqual(out.map((c) => c.id), ["page:workspaces"]);
});

test("filterCommands keywords 英文别名大小写不敏感", () => {
  const out = filterCommands(COMMANDS, "TERM");
  assert.deepEqual(out.map((c) => c.id), ["page:terminal"]);
});

test("filterCommands 无命中返回空数组", () => {
  assert.deepEqual(filterCommands(COMMANDS, "不存在的东西"), []);
});
