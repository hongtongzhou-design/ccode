import type { ReactNode } from "react";

const WIDTHS = {
  narrow: "max-w-2xl",
  standard: "max-w-4xl",
  wide: "max-w-[1440px]",
} as const;

export function PageFrame({
  children,
  className = "",
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: keyof typeof WIDTHS;
}) {
  return (
    <div className="ccode-page-frame min-h-full bg-canvas px-6 pb-6 pt-1">
      <div className={`ccode-page-content mx-auto w-full ${WIDTHS[width]} ${className}`}>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="ccode-page-header sticky top-0 z-20 mb-4 flex h-12 items-center justify-between gap-4 bg-canvas">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="shrink-0 text-base font-semibold tracking-tight text-l1">
          {title}
        </h1>
        {meta && <span className="truncate text-[11px] text-l4">{meta}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export const primaryActionClass =
  "ccode-action-primary inline-flex h-8 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryActionClass =
  "ccode-action-secondary inline-flex h-8 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

/** 行内 28px 描边次按钮：列表行/工具栏次级操作统一口径（原各页 secBtn 逐字复制的收敛点） */
export const rowActionClass =
  "inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-2.5 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:opacity-50";

/** 行内 28px 无框低调按钮：辅助/低频动作 */
export const ghostActionClass =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l3 transition-colors hover:bg-white/5 hover:text-l1 disabled:opacity-50";

/** 表单输入框：模态与内联表单统一（canvas 底 + field 边） */
export const fieldClass =
  "w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 搜索输入框：inset 底色分层（无描边，聚焦时底色加深一档），与表单输入区分开 */
export const searchFieldClass =
  "h-8 rounded-md bg-inset px-2.5 text-xs text-l2 outline-none transition-colors placeholder:text-l4 focus:bg-raised";

/** hover 才现的低频操作：行挂 group，按钮用此类；键盘 Tab 聚焦（focus-visible）同样显示 */
export const hoverRevealClass =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

/** 分段切换（状态筛选/时间范围）：胶囊行，选中 bg-seg-sel，未选中灰字 */
export function SegTabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1 ${className}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className={`flex h-7 items-center rounded-full px-3 text-xs transition-colors ${
            value === item.id ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PageToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`ccode-page-toolbar mb-5 flex min-h-11 flex-wrap items-center justify-between gap-2 py-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-3 flex size-9 items-center justify-center text-lg text-l4">
        ○
      </div>
      <p className="text-sm font-medium text-l2">{title}</p>
      {detail && <div className="mt-1 max-w-md text-xs leading-5 text-l4">{detail}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
        checked ? "border-cta-bd bg-cta" : "border-field bg-inset"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-l1 transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className = "",
  align = "center",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  className?: string;
  align?: "center" | "start";
}) {
  return (
    <label
      className={`flex cursor-pointer gap-1.5 ${align === "start" ? "items-start" : "items-center"} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[10px] ${align === "start" ? "mt-0.5" : ""} ${
          checked
            ? "border-cta-bd bg-cta text-cta-text"
            : "border-field bg-canvas text-transparent"
        }`}
      >
        {checked ? "✓" : ""}
      </span>
      {label}
    </label>
  );
}

export function LoadingRows({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      aria-label="加载中"
      className={`animate-pulse space-y-3 ${compact ? "py-2" : "py-6"}`}
    >
      {["w-3/5", "w-full", "w-4/5"].map((width, index) => (
        <div key={index} className={`h-3 rounded bg-inset ${width}`} />
      ))}
    </div>
  );
}
