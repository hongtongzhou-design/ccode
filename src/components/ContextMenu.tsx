import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect?: () => void;
  /** 禁用项：渲染为不可点，title 说明原因（如互斥脚本运行中） */
  disabled?: boolean;
  title?: string;
}

/**
 * 轻量右键菜单：全屏 overlay + 浮动面板，
 * 点击空白 / Escape / 滚动任一发生即关闭。
 * alignRight 时 x 视为锚点右缘，按实际面板宽度右对齐。
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  alignRight = false,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  alignRight?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // capture 阶段的滚动监听能捕获任意容器的滚动
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // 右对齐需实测面板宽度；useLayoutEffect 保证绘制前完成修正，不闪动
  useLayoutEffect(() => {
    if (!alignRight) return;
    const el = panelRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setMeasured({
      left: Math.max(4, Math.min(x - w, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [alignRight, x, y, items.length]);

  // 防出屏：简单往左/往上收（右对齐时先按估算渲染，随后由实测修正）
  const style = measured ?? {
    left: Math.max(
      4,
      Math.min(alignRight ? x - 160 : x, window.innerWidth - 180),
    ),
    top: Math.max(4, Math.min(y, window.innerHeight - items.length * 32 - 16)),
  };

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="absolute min-w-40 rounded border border-field bg-strip py-1"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.label}
            disabled={it.disabled}
            title={it.title}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onSelect?.();
            }}
            className={`block w-full px-3 py-1.5 text-left text-sm ${
              it.disabled
                ? "cursor-not-allowed text-l4"
                : "text-l2 hover:bg-white/5"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
