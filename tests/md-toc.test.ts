import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  headingsFromElement,
  MD_TOC_MIN,
  revealMdHeading,
  slugifyHeading,
} from "../src/md-toc.ts";

test("slugifyHeading：汉字保留，空白折成横线，空标题回落 section", () => {
  assert.equal(slugifyHeading("方法"), "方法");
  assert.equal(slugifyHeading("1. 研究问题"), "1-研究问题");
  assert.equal(slugifyHeading("  Hello World  "), "hello-world");
  assert.equal(slugifyHeading("***"), "section");
});

test("headingsFromElement 收集标题并补 id，重复标题加序号", () => {
  const dom = new JSDOM("<div id='root'><h1>引言</h1><h2>方法</h2><h2>方法</h2><p>不是标题</p></div>");
  const root = dom.window.document.getElementById("root")!;
  const headings = headingsFromElement(root);
  assert.equal(headings.length, 3);
  assert.deepEqual(headings.map((h) => h.id), ["引言", "方法", "方法-2"]);
  assert.equal(root.querySelectorAll("h1[id], h2[id]").length, 3);
});

test("headingsFromElement 保留已有 id", () => {
  const dom = new JSDOM("<div><h1 id='keep'>标题</h1></div>");
  const root = dom.window.document.querySelector("div")!;
  assert.equal(headingsFromElement(root)[0]?.id, "keep");
});

test("revealMdHeading 展开祖先 details", () => {
  const dom = new JSDOM(
    "<div id='root'><details><summary>折</summary><h2 id='inside'>内</h2></details></div>",
  );
  const root = dom.window.document.getElementById("root")!;
  const details = root.querySelector("details")!;
  assert.equal(details.hasAttribute("open"), false);
  const el = revealMdHeading(root, "inside");
  assert.ok(el);
  assert.equal(details.hasAttribute("open"), true);
  assert.equal(revealMdHeading(root, "missing"), null);
});

test("目录门槛是 3", () => {
  assert.equal(MD_TOC_MIN, 3);
});
