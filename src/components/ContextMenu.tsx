import { useEffect } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

/**
 * 轻量右键菜单：全屏 overlay + 浮动面板，
 * 点击空白 / Escape / 滚动任一发生即关闭。
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
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

  // 防出屏：简单往左/往上收
  const style = {
    left: Math.max(4, Math.min(x, window.innerWidth - 180)),
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
        className="absolute min-w-40 rounded border border-neutral-200 bg-white py-1 shadow-lg"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.label}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
