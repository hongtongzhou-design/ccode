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
    <div className="min-h-full bg-canvas px-6 pb-6 pt-1">
      <div className={`mx-auto w-full ${WIDTHS[width]} ${className}`}>{children}</div>
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
    <header className="sticky top-0 z-20 mb-4 flex h-12 items-center justify-between gap-4 border-b border-hairline bg-canvas">
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
  "inline-flex h-8 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryActionClass =
  "inline-flex h-8 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

export function PageToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-5 flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-md border border-hairline bg-strip px-3 py-2 ${className}`}
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
      <div className="mb-3 flex size-9 items-center justify-center rounded-md border border-hairline bg-strip text-l4">
        ·
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
