/**
 * 文件交付类评审的改动分组（精读/大纲/写作/排版等）。
 * 检索步分组仍在 screening-review.ts。
 */

import { normReviewPath } from "./screening-review.ts";

export type DeliveryFileGroupId =
  | "notes"
  | "manuscript"
  | "index"
  | "fetch"
  | "other"
  | "machine";

export const DELIVERY_FILE_GROUP_LABEL: Record<DeliveryFileGroupId, string> = {
  notes: "笔记",
  manuscript: "稿件",
  index: "引文",
  fetch: "待获取",
  other: "其他改动",
  machine: "过程",
};

export const DELIVERY_FILE_GROUP_ORDER: DeliveryFileGroupId[] = [
  "notes",
  "manuscript",
  "index",
  "fetch",
  "other",
  "machine",
];

function fileName(path: string): string {
  const p = normReviewPath(path);
  return p.split("/").pop() ?? p;
}

export function deliveryFileGroup(path: string): DeliveryFileGroupId {
  const p = normReviewPath(path);
  const base = fileName(p);
  if (base === "to-fetch.md" || base === "to-fetch.ris") return "fetch";
  if (
    base === "index.json" ||
    base.endsWith(".bib") ||
    base === "citation-check.md"
  ) {
    return "index";
  }
  if (p === "notes" || p.startsWith("notes/") || p.includes("/notes/")) {
    return "notes";
  }
  if (
    base === "zotero-sync.md" ||
    p === "scripts" ||
    p.startsWith("scripts/") ||
    p.includes("/scripts/") ||
    base.endsWith(".json")
  ) {
    return "machine";
  }
  if (
    base === "outline.md" ||
    base === "design.md" ||
    base === "data-dictionary.md" ||
    base === "analysis-report.md" ||
    p.startsWith("manuscript/") ||
    p.startsWith("chapters/") ||
    p.startsWith("proposal/") ||
    p.startsWith("output/") ||
    p.includes("/manuscript/") ||
    p.includes("/chapters/") ||
    p.includes("/proposal/") ||
    base.endsWith(".tex") ||
    base.endsWith(".qmd")
  ) {
    return "manuscript";
  }
  return "other";
}

export function sortDeliveryPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    const ga = DELIVERY_FILE_GROUP_ORDER.indexOf(deliveryFileGroup(a));
    const gb = DELIVERY_FILE_GROUP_ORDER.indexOf(deliveryFileGroup(b));
    if (ga !== gb) return ga - gb;
    return normReviewPath(a).localeCompare(normReviewPath(b), "zh");
  });
}

export function groupDeliveryFiles<T extends { path: string }>(
  files: readonly T[],
): { id: DeliveryFileGroupId; label: string; files: T[] }[] {
  const buckets: Record<DeliveryFileGroupId, T[]> = {
    notes: [],
    manuscript: [],
    index: [],
    fetch: [],
    other: [],
    machine: [],
  };
  for (const file of files) buckets[deliveryFileGroup(file.path)].push(file);
  for (const id of DELIVERY_FILE_GROUP_ORDER) {
    const order = sortDeliveryPaths(buckets[id].map((f) => f.path));
    const map = new Map(buckets[id].map((f) => [f.path, f]));
    buckets[id] = order.map((p) => map.get(p)!);
  }
  return DELIVERY_FILE_GROUP_ORDER.map((id) => ({
    id,
    label: DELIVERY_FILE_GROUP_LABEL[id],
    files: buckets[id],
  })).filter((g) => g.files.length > 0);
}
