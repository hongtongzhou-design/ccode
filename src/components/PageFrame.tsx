import type { MouseEvent, ReactNode } from "react";
import { useRef } from "react";
import { HoverTip, useHoverTip } from "./HoverTip";

const WIDTHS = {
  narrow: "max-w-2xl",
  standard: "max-w-4xl",
  /** 可选中宽外壳（约 1080px）。设置/MCP 已改 fluid，保留给以后要限宽的阅读页。 */
  settings: "max-w-[1080px]",
  wide: "max-w-[1440px]",
  /** 连续工作区页面：使用主区全部可用宽度，内容自身维持固定密度。 */
  fluid: "max-w-none",
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
  leading,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** 页面级标题前的轻量入口（例如工作区页收起后的项目列表恢复按钮）。 */
  leading?: ReactNode;
}) {
  return (
    <header className="ccode-page-header sticky top-0 z-20 mb-4 flex h-12 items-center justify-between gap-4 bg-canvas">
      <div className="flex min-w-0 items-center gap-2.5">
        {leading}
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="shrink-0 text-base font-semibold tracking-tight text-l1">
            {title}
          </h1>
          {meta && <span className="truncate text-micro text-l4">{meta}</span>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export const primaryActionClass =
  "ccode-action-primary inline-flex h-8 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryActionClass =
  "ccode-action-secondary inline-flex h-8 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:cursor-not-allowed disabled:opacity-50";

/** 项目页文档/笔记/工作树等内容井：canvas/strip 混色，浅色不另垫白纸 */
export const projectWellClass = "ccode-well rounded-lg p-3";

/** 行内 28px 描边次按钮：列表行/工具栏次级操作统一口径（原各页 secBtn 逐字复制的收敛点） */
export const rowActionClass =
  "inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-2.5 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1 disabled:opacity-50";

/** 行内 28px 无框低调按钮：辅助/低频动作 */
export const ghostActionClass =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50";

/** 流程卡片内的轻量操作：与列表行操作共用 28px 热区，但不带描边。 */
export const inlineActionClass =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 transition-colors hover:bg-hover hover:text-l1 disabled:opacity-50";

/** 流程卡片内的紧凑主动作：仅用于卡片内部，不与页面主 CTA 抢层级。 */
export const compactPrimaryActionClass =
  "inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-2 text-xs text-cta-text transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

/** 紧凑表单控件：与标准 field 同源，只收窄高度和字号。 */
export const compactFieldClass =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 表单输入框：模态与内联表单统一（canvas 底 + field 边） */
export const fieldClass =
  "w-full rounded-md border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 搜索输入框：inset 底色分层（无描边，聚焦时底色加深一档），与表单输入区分开 */
export const searchFieldClass =
  "h-8 rounded-md bg-inset px-2.5 text-xs text-l2 outline-none transition-colors placeholder:text-l4 focus:bg-raised";

/** hover 才现的低频操作：行挂 group，按钮用此类；键盘 Tab 聚焦（focus-visible）同样显示 */
export const hoverRevealClass =
  "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

/** 行内悬浮操作钮（v3.93）：自带「锚点上方」应用内 tooltip——原生 title 渲染在光标下方，
 *  与胶囊动作栏视觉脱节；点击先收 tooltip 再透传事件（⋯ 要取按钮锚点定位菜单）。
 *  点击区保持 h-7 w-7（≥28px 硬约束）。 */
export function RowAction({
  icon,
  tip,
  label,
  onClick,
}: {
  icon: string;
  tip: string;
  label: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { tip: pos, show, hide } = useHoverTip(ref, true);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onClick={(e) => {
        hide();
        onClick(e);
      }}
      className="flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
    >
      {icon}
      <HoverTip tip={pos} text={tip} up />
    </button>
  );
}

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
  compact = false,
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  /** 页面内嵌卡片使用的紧凑空态，不改变管理页默认留白。 */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 text-center ${
        compact ? "min-h-32 py-6" : "min-h-48 py-10"
      }`}
    >
      {/* 原来这里有个空心圆图标：它不表达任何东西，纯占位。去掉后标题自然成为视觉起点 */}
      <p className="text-base font-medium text-l1">{title}</p>
      {detail && (
        <div className="mt-2 max-w-lg text-xs leading-6 text-l3">{detail}</div>
      )}
      {action && <div className="mt-5">{action}</div>}
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
        checked ? "border-cta-bd bg-cta" : "border-field bg-switch-off"
      }`}
    >
      {/* 滑块用专用令牌而非 bg-l1：l1 是「文字最亮档」，在浅色主题是近黑 #171a26，
          直接当滑块会渲染成白底上的黑疙瘩（v3.85 修）。滑块永远是浅色，状态由轨道表达。
          开启态轨道 = 品牌色 bg-cta（随主题；2026-08-25 试过降调柔绿 bg-ok-text，用户拍板改回） */}
      <span
        className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-switch-knob transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** 折叠指示：旋转 chevron，替代 ▸/▾ 小字。
 *  boxed = 分区/组头用的 28px 模块；列表行、树节点用默认紧凑档。 */
export function FoldMark({
  open,
  boxed = false,
}: {
  open: boolean;
  boxed?: boolean;
}) {
  const svg = (
    <svg
      aria-hidden="true"
      width={boxed ? 12 : 10}
      height={boxed ? 12 : 10}
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 transition-transform duration-150 ${open ? "rotate-0" : "-rotate-90"}`}
    >
      <path
        d="M2.75 4.25 L6 8 L9.25 4.25"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
  return (
    <span
      aria-hidden="true"
      className={
        boxed
          ? "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-inset text-l2"
          : "inline-flex h-5 w-5 shrink-0 items-center justify-center text-l3"
      }
    >
      {svg}
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className = "",
  align = "center",
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  className?: string;
  align?: "center" | "start";
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      title={title}
      className={`flex gap-1.5 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${align === "start" ? "items-start" : "items-center"} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-micro ${align === "start" ? "mt-0.5" : ""} ${
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
        <div key={index} className={`h-3 rounded-sm bg-inset ${width}`} />
      ))}
    </div>
  );
}

/** 一次性提示条（注册结果、模板已应用、git 引导等）：全站同一副长相。
 *  原先各页各写一份裸文字或自制 div——ProjectGroup 一个文件里就有 5 份「知道了」条，
 *  文案长了就散架（顶部 notice 是一行绿字，塞进两句话后既挤又刺眼）。
 *  版式取自工作区创建成功条：inset 卡片 + 语义色仅用在图标上，正文保持正常前景色。 */
export function NoticeBar({
  tone = "ok",
  children,
  onDismiss,
  className = "",
}: {
  /** ok = 完成（绿勾）；info = 中性说明（无图标）；warn = 需留意 */
  tone?: "ok" | "info" | "warn";
  children: React.ReactNode;
  /** 给了才显示「知道了」——不给就是随时间自动消失的那种 */
  onDismiss?: () => void;
  className?: string;
}) {
  const icon = tone === "ok" ? "✓" : tone === "warn" ? "!" : null;
  const iconCls =
    tone === "ok" ? "text-ok-text" : tone === "warn" ? "text-warn-text" : "";
  return (
    <div
      className={`flex items-start gap-2 rounded-md bg-strip px-3 py-2.5 text-xs leading-5 text-l2 ${className}`}
    >
      {icon && <span className={`shrink-0 ${iconCls}`}>{icon}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-l4 hover:bg-hover hover:text-l1"
        >
          知道了
        </button>
      )}
    </div>
  );
}

/** 步骤角色标记（v3.89）：ai = AI 干活你验收 / you = 要你出场 / both = 协作。
 *  步骤名保留学术术语（文献检索与筛选…），角色单独标出来——
 *  用户真正要知道的是「哪几步轮到我」，而不是这一步产出什么文件。 */
export function RoleBadge({ role }: { role?: string }) {
  const r = role === "you" || role === "both" ? role : "ai";
  const meta = {
    ai: { text: "AI 做", cls: "text-l4" },
    you: { text: "你来", cls: "text-cta" },
    both: { text: "一起", cls: "text-l3" },
  }[r];
  return (
    <span
      className={`shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-micro ${meta.cls}`}
      title={
        r === "you"
          ? "这一步主要靠你，AI 打下手"
          : r === "both"
            ? "这一步你和 AI 一起定"
            : "这一步 AI 干活，做完你验收"
      }
    >
      {meta.text}
    </span>
  );
}
