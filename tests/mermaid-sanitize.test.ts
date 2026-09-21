import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { sanitizeMermaidSvg } from "../src/mermaid-sanitize.ts";

const dom = new JSDOM("");
const doc = dom.window.document;

test("良性 svg 保真", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>`;
  const out = sanitizeMermaidSvg(svg, doc);
  assert.match(out, /<svg/i);
  assert.match(out, />A</);
});

test("剥 script / foreignObject / 事件 / 全部 href", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">
    <script>alert(1)</script>
    <foreignObject><div>x</div></foreignObject>
    <a href="javascript:alert(1)" onclick="alert(1)">
      <text>ok</text>
    </a>
  </svg>`;
  const out = sanitizeMermaidSvg(svg, doc);
  assert.doesNotMatch(out, /script/i);
  assert.doesNotMatch(out, /foreignObject/i);
  assert.doesNotMatch(out, /href/i);
  assert.doesNotMatch(out, /onclick/i);
  assert.match(out, />ok</);
});

test("畸形 XML 与非 svg 根返回空串", () => {
  assert.equal(sanitizeMermaidSvg("<not-svg></not-svg>", doc), "");
  assert.equal(sanitizeMermaidSvg("<svg><", doc), "");
});
