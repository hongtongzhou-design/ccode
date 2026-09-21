import assert from "node:assert/strict";
import test from "node:test";
import { hasMermaidFence } from "../src/mermaid-blocks.ts";

test("识别 mermaid 围栏：大小写、属性后缀、波浪号", () => {
  assert.equal(hasMermaidFence("```mermaid\ngraph TD; A-->B;\n```"), true);
  assert.equal(hasMermaidFence("```Mermaid\nA\n```"), true);
  assert.equal(hasMermaidFence("```mermaid {theme: dark}\nA\n```"), true);
  assert.equal(hasMermaidFence("~~~mermaid\nA\n~~~"), true);
});

test("非 mermaid 围栏与围栏内字面 mermaid 不误报", () => {
  assert.equal(hasMermaidFence("```ts\nconst mermaid = 1;\n```"), false);
  assert.equal(hasMermaidFence("普通正文 mermaid"), false);
  assert.equal(hasMermaidFence("```\nmermaid\n```"), false);
});

test("未闭合 mermaid 围栏仍算有图", () => {
  assert.equal(hasMermaidFence("```mermaid\ngraph TD"), true);
});
