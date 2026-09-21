/** 标题 ≥ 这个数才出浮动目录。 */
export const MD_TOC_MIN = 3;

export interface MdHeading {
  id: string;
  level: number;
  text: string;
}

/** 标题锚点：字母数字保留，其余折成 `-`；空标题回落 section。 */
export function slugifyHeading(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s || "section";
}

function headingIdOf(el: Element, used: Map<string, number>): string {
  const existing = el.getAttribute("id")?.trim();
  if (existing) return existing;
  const base = slugifyHeading((el.textContent ?? "").replace(/\s+/g, " ").trim());
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

/** 从已渲染 DOM 收集 h1–h6，缺 id 的就地补上。 */
export function headingsFromElement(root: Element): MdHeading[] {
  const used = new Map<string, number>();
  for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const id = el.getAttribute("id")?.trim();
    if (id) used.set(id, (used.get(id) ?? 0) + 1);
  }
  const out: MdHeading[] = [];
  for (const el of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const level = Number(el.tagName.slice(1));
    if (level < 1 || level > 6) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const id = headingIdOf(el, used);
    if (!el.getAttribute("id")) el.setAttribute("id", id);
    out.push({ id, level, text });
  }
  return out;
}

/** 展开祖先 details 后滚到该标题。找不到返回 null。 */
export function revealMdHeading(root: Element, id: string): Element | null {
  const safe = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const el = root.querySelector(`[id="${safe}"]`);
  if (!el) return null;
  let p: Element | null = el;
  while (p) {
    if (p.tagName === "DETAILS" && !p.hasAttribute("open")) {
      p.setAttribute("open", "");
    }
    p = p.parentElement;
  }
  if ("scrollIntoView" in el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  return el;
}
