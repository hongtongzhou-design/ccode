import {
  FileSpreadsheet,
  FileText,
  Image,
  LayoutGrid,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { OFFICE_FILTERS } from "../work-mode";
import type { OfficeDocKind } from "../work-mode";
import type { ProjectFileFilter } from "../project-files";

const ICONS: Record<ProjectFileFilter, LucideIcon | "pdf"> = {
  all: LayoutGrid,
  doc: FileText,
  sheet: FileSpreadsheet,
  slide: Presentation,
  pdf: "pdf",
  image: Image,
  other: FileText,
};

const LABELS: Record<ProjectFileFilter, string> = {
  all: "全部",
  doc: "文档",
  sheet: "表格",
  slide: "幻灯",
  pdf: "PDF",
  image: "图片",
  other: "其他",
};

export default function FileKindFilters({
  filter,
  counts,
  onChange,
}: {
  filter: ProjectFileFilter;
  counts: Record<OfficeDocKind | "all", number>;
  onChange: (id: ProjectFileFilter) => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
      role="radiogroup"
      aria-label="文件类型"
    >
      {OFFICE_FILTERS.filter(
        (item) =>
          item.id === "all" || item.id === filter || counts[item.id] > 0,
      ).map((item) => {
        const count = item.id === "all" ? 0 : counts[item.id];
        const Icon = ICONS[item.id];
        const selected = filter === item.id;
        const label = LABELS[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={label}
            aria-label={count > 0 ? `${label} ${count}` : label}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${
              selected ? "bg-seg-sel text-l1" : "text-l3 hover:bg-hover hover:text-l1"
            }`}
            onClick={() => onChange(item.id)}
          >
            {Icon === "pdf" ? (
              <span className="font-mono text-micro">PDF</span>
            ) : (
              <Icon size={13} strokeWidth={1.8} />
            )}
            {count > 0 && <span className="text-micro text-l4">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
