/**
 * 技能页列表的展示口径（2026-10-31 用户：「按建议做」；tests/skill-list-display.test.ts）。
 * - 描述行只显示第一句：SKILL.md 的 description 是写给 Agent 的触发说明（「××规范。当用户要求……时使用」），
 *   第一句就是给人看的名字，全文留在悬停和右侧详情。只改显示，不动技能文件。
 * - 「Mesa 内置」组内按用途加小标题（10-11 拍板的「Mesa 内置」分组不动）；组内原有顺序不变。
 */

/** 描述的第一句；中文到第一个「。」，英文到第一个「. 」；取不出（或整段只有一句）原样返回 */
export function skillSummary(desc: string): string {
  const t = desc.trim();
  const zh = t.indexOf("。");
  const en = t.search(/\.\s/);
  const cut = [zh, en].filter((i) => i > 0).sort((a, b) => a - b)[0];
  return cut === undefined ? t : t.slice(0, cut);
}

/** 内置技能按用途分小节；顺序即小节顺序。新增内置技能没登记的落「其他」 */
export const BUILTIN_USAGE_GROUPS: ReadonlyArray<{ label: string; names: readonly string[] }> = [
  { label: "文献", names: ["lit-search", "lit-notes", "lit-watch", "zotero-sync", "endnote-bridge"] },
  {
    label: "数据与作图",
    names: ["data-clean", "data-eda", "figure-forge", "origin-plot", "image-gen", "blender-research"],
  },
  {
    label: "写作与成稿",
    names: [
      "proposal-writer",
      "review-framework",
      "review-writing",
      "review-figures",
      "research-writing",
      "rebuttal-crafter",
      "slides-deck",
      "quarto-render",
    ],
  },
  { label: "审查与校对", names: ["bib-check", "stats-check"] },
];

/** 把一组技能按用途切成小节；空小节不出；每节内保持传入顺序 */
export function groupByUsage<T extends { name: string }>(
  skills: readonly T[],
): { label: string; skills: T[] }[] {
  const out = BUILTIN_USAGE_GROUPS.map((g) => ({
    label: g.label,
    skills: skills.filter((s) => g.names.includes(s.name)),
  }));
  const known = new Set(BUILTIN_USAGE_GROUPS.flatMap((g) => g.names));
  out.push({ label: "其他", skills: skills.filter((s) => !known.has(s.name)) });
  return out.filter((g) => g.skills.length > 0);
}
