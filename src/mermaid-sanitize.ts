const DROP_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "img",
  "video",
  "audio",
  "input",
  "button",
  "form",
  "link",
  "meta",
  "base",
  "style",
]);

function isDroppedTag(name: string): boolean {
  return DROP_TAGS.has(name.toLowerCase());
}

function stripDangerousAttrs(el: Element): void {
  for (const attr of [...el.attributes]) {
    const name = attr.name;
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || lower.startsWith("@")) {
      el.removeAttribute(name);
      continue;
    }
    if (
      lower === "href" ||
      lower === "xlink:href" ||
      lower.endsWith(":href")
    ) {
      el.removeAttribute(name);
    }
  }
}

/**
 * mermaid.render 产出的 SVG 二次清洗：去掉可执行面与全部链接。
 * 解析失败或根不是 svg 返回空串，调用方回落源码。
 */
export function sanitizeMermaidSvg(svg: string, document: Document): string {
  const parser = new document.defaultView!.DOMParser();
  const parsed = parser.parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return "";
  const root = parsed.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") return "";
  const doomed: Element[] = [];
  const walk = (el: Element) => {
    if (isDroppedTag(el.localName) || isDroppedTag(el.tagName)) {
      doomed.push(el);
      return;
    }
    stripDangerousAttrs(el);
    for (const child of [...el.children]) walk(child);
  };
  walk(root);
  for (const el of doomed) el.remove();
  return root.outerHTML;
}
