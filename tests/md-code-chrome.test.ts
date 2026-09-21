import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  decorateMdCodeBlocks,
  isMermaidLanguage,
  languageFromCodeClass,
} from "../src/md-code-chrome.ts";

test("languageFromCodeClass 抽出 language- 后缀", () => {
  assert.equal(languageFromCodeClass("language-ts"), "ts");
  assert.equal(languageFromCodeClass("foo language-c++ bar"), "c++");
  assert.equal(languageFromCodeClass(""), "");
});

test("isMermaidLanguage 大小写不敏感", () => {
  assert.equal(isMermaidLanguage("mermaid"), true);
  assert.equal(isMermaidLanguage("Mermaid"), true);
  assert.equal(isMermaidLanguage("ts"), false);
});

test("decorateMdCodeBlocks 给普通围栏套头栏，mermaid 只打标", () => {
  const dom = new JSDOM(
    `<div>
      <pre><code class="language-ts">const a = 1;</code></pre>
      <pre><code class="language-mermaid">graph TD; A-->B;</code></pre>
    </div>`,
  );
  const host = dom.window.document.querySelector("div")!;
  decorateMdCodeBlocks(host);
  assert.equal(host.querySelectorAll("[data-md-code]").length, 1);
  assert.equal(host.querySelector(".md-code-lang")?.textContent, "ts");
  assert.equal(host.querySelector("[data-md-mermaid]")?.tagName, "PRE");
  decorateMdCodeBlocks(host);
  assert.equal(host.querySelectorAll("[data-md-code]").length, 1);
});
