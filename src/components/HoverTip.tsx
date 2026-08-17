import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";

/** 应用内悬浮提示（tooltip）：fixed 定位不随滚动容器走，滚动/缩放即关。
 *  WKWebView 的原生 title 悬浮有平台差异（不渲染或移开后残留数秒），需要稳定悬浮的
 *  控件统一走这里；事件一律挂在包裹 span 上，禁用按钮也能悬浮查看。
 *  经 createPortal 挂到 body：祖先若有 opacity/transform（会改变 fixed 包含块）也不影响定位。 */
export function useHoverTip(
  ref: RefObject<HTMLElement | null>,
  /** up=true 弹到锚点上方（行尾操作栏等下方贴边/易脱节的场景），缺省下方 */
  up = false,
) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip]);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 横向钳制在窗口内（tooltip max-w-72 半宽 144 + 边距）
    const x = Math.min(
      Math.max(r.left + r.width / 2, 150),
      window.innerWidth - 150,
    );
    // up 时 y 指到锚点上缘，由 HoverTip 用 -translate-y-full 翻上去
    setTip({ x, y: up ? r.top - 8 : r.bottom + 8 });
  };
  return { tip, show, hide: () => setTip(null) };
}

export function HoverTip({
  tip,
  text,
  warn,
  up,
}: {
  tip: { x: number; y: number } | null;
  text: string;
  /** 警告色小字行（如上游漂移提醒），附加在正文之后 */
  warn?: string | null;
  /** 与 useHoverTip 的 up 配对：tooltip 翻转到锚点上方 */
  up?: boolean;
}) {
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className={`pointer-events-none fixed z-50 max-w-72 -translate-x-1/2 whitespace-pre-line rounded-md border border-hairline ccode-float-surface px-2.5 py-1.5 text-left text-xs leading-5 text-l2 ${up ? "-translate-y-full" : ""}`}
      style={{ left: tip.x, top: tip.y }}
    >
      {text}
      {warn && <div className="text-warn-text">{warn}</div>}
    </div>,
    document.body,
  );
}
