import { useEffect, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { NAV_GROUPS, NAV_BOTTOM, type NavItem } from "../navigation";
import {
  isNavCapsuleItemVisible,
  normalizeNavCapsuleDelay,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
} from "../nav-capsule";
import { NAV_ICONS } from "../navigation-icons";

const HINT_KEY = "ccode.navCapsuleHintSeen";

function pageTitle(item: NavItem, runningCount: number, inboxCount: number) {
  if (item.id === "terminal" && runningCount > 0)
    return `${item.label}（${runningCount} 个 agent 运行中）`;
  if (item.id === "workspaces" && inboxCount > 0)
    return `${item.label}（${inboxCount} 件待处理）`;
  return item.label;
}

export default function TopNavCapsule({
  page,
  onPage,
  onQuickChat,
  onQuickChatContextMenu,
  onRestore,
  runningCount,
  inboxCount,
  hideDelayMs,
  displayMode,
  visibleItems,
}: {
  page: string;
  onPage: (id: string) => void;
  onQuickChat: () => void;
  onQuickChatContextMenu: (e: React.MouseEvent) => void;
  onRestore: () => void;
  runningCount: number;
  inboxCount: number;
  hideDelayMs: number;
  displayMode?: string;
  visibleItems?: unknown;
}) {
  const delay = normalizeNavCapsuleDelay(hideDelayMs);
  const mode = normalizeNavCapsuleDisplayMode(displayMode);
  const configuredItems = normalizeNavCapsuleVisibleItems(visibleItems);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      isNavCapsuleItemVisible(item.id, page, configuredItems),
    ),
  })).filter((group) => group.items.length > 0);
  const bottomItems = NAV_BOTTOM.filter((item) =>
    isNavCapsuleItemVisible(item.id, page, configuredItems),
  );
  const showQuickChat = configuredItems.includes("quick-chat");
  const [visible, setVisible] = useState(true);
  const [focused, setFocused] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);
  const timerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const capsuleRef = useRef<HTMLElement>(null);

  const clearHideTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const hideLater = (force = false) => {
    clearHideTimer();
    if ((focused || pointerInsideRef.current) && !force) return;
    timerRef.current = window.setTimeout(() => setVisible(false), delay);
  };
  const reveal = () => {
    clearHideTimer();
    setVisible(true);
  };
  const revealForKeyboard = () => {
    reveal();
    window.requestAnimationFrame(() => {
      const firstId = showQuickChat
        ? "quick-chat"
        : groups[0]?.items[0]?.id ?? bottomItems[0]?.id ?? "restore";
      itemRefs.current[firstId]?.focus();
    });
  };

  useEffect(() => {
    const seen = localStorage.getItem(HINT_KEY) === "1";
    if (seen) return;
    localStorage.setItem(HINT_KEY, "1");
    setHintVisible(true);
    const id = window.setTimeout(() => setHintVisible(false), 3200);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setVisible(false), 2500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onWindowBlur = () => {
      clearHideTimer();
      setVisible(false);
      setFocused(false);
      pointerInsideRef.current = false;
    };
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      clearHideTimer();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    itemRefs.current[page]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [page, visible]);

  const showIcon = mode !== "labels";
  const showLabel = mode !== "icons";
  const itemContent = (Icon: NavItem["Icon"], label: string) => (
    <>
      {showIcon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
      {showLabel && <span>{label}</span>}
    </>
  );

  return (
    <>
      <button
        type="button"
        className="ccode-nav-capsule-sentinel"
        tabIndex={visible ? -1 : 0}
        aria-label="显示顶部导航"
        onFocus={revealForKeyboard}
      />
      <div
        className="fixed inset-x-0 top-10 z-[44] h-3"
        onMouseEnter={reveal}
        onMouseLeave={() => hideLater()}
        aria-hidden="true"
      />
      {visible && (
      <div
        className="pointer-events-none fixed inset-x-0 top-[52px] z-[45] flex justify-center"
      >
        <nav
          ref={capsuleRef}
          aria-label="全局导航"
          className="ccode-top-nav-capsule ccode-float-surface pointer-events-auto flex max-w-[calc(100vw-24px)] items-center gap-1 overflow-x-auto rounded-full border border-field px-1.5 py-1"
          onMouseEnter={() => {
            pointerInsideRef.current = true;
            reveal();
          }}
          onMouseLeave={() => {
            pointerInsideRef.current = false;
            hideLater();
          }}
          onFocus={() => {
            reveal();
            setFocused(true);
          }}
          onBlur={(e) => {
            if (
              e.relatedTarget instanceof Node &&
              capsuleRef.current?.contains(e.relatedTarget)
            )
              return;
            setFocused(false);
            hideLater();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setFocused(false);
              setVisible(false);
            }
          }}
        >
            {showQuickChat && (
              <button
                ref={(el) => {
                  itemRefs.current["quick-chat"] = el;
                }}
                type="button"
                onClick={onQuickChat}
                onContextMenu={onQuickChatContextMenu}
                aria-label="快速开聊"
                title="快速开聊：右键查看随手聊历史"
                className="ccode-top-nav-item shrink-0"
              >
                {itemContent(NAV_ICONS.quickChat, "快速开聊")}
              </button>
            )}
            {showQuickChat && groups.length > 0 && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            {groups.map((group, groupIndex) => (
              <span key={group.label} className="contents">
                {group.items.map((item) => {
                  const active = page === item.id;
                  return (
                    <button
                      key={item.id}
                      ref={(el) => {
                        itemRefs.current[item.id] = el;
                      }}
                      type="button"
                      onClick={() => onPage(item.id)}
                      aria-current={active ? "page" : undefined}
                      aria-label={item.label}
                      title={pageTitle(item, runningCount, inboxCount)}
                      className={`ccode-top-nav-item shrink-0 ${active ? "ccode-top-nav-item-active" : ""}`}
                    >
                      {itemContent(item.Icon, item.label)}
                      {item.id === "terminal" && runningCount > 0 && (
                        <span className="ccode-top-nav-badge">{runningCount}</span>
                      )}
                      {item.id === "workspaces" && inboxCount > 0 && (
                        <span className="ccode-top-nav-badge">{inboxCount}</span>
                      )}
                    </button>
                  );
                })}
                {groupIndex < groups.length - 1 && (
                  <span className="ccode-top-nav-separator" aria-hidden="true" />
                )}
              </span>
            ))}
            {(groups.length > 0 || showQuickChat) && bottomItems.length > 0 && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            {bottomItems.map((item) => {
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[item.id] = el;
                  }}
                  type="button"
                  onClick={() => onPage(item.id)}
                  aria-current={active ? "page" : undefined}
                  aria-label={item.label}
                  title={item.label}
                  className={`ccode-top-nav-item shrink-0 ${active ? "ccode-top-nav-item-active" : ""}`}
                >
                  {itemContent(item.Icon, item.label)}
                </button>
              );
            })}
            {(showQuickChat || groups.length > 0 || bottomItems.length > 0) && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            <button
              ref={(el) => {
                itemRefs.current["restore"] = el;
              }}
              type="button"
              onClick={onRestore}
              aria-label="恢复侧栏"
              title="恢复侧栏"
              className="ccode-top-nav-item shrink-0"
            >
              {itemContent(PanelLeftOpen, "恢复侧栏")}
            </button>
          </nav>
          {hintVisible && (
            <div className="ccode-nav-capsule-hint" role="status">
              顶部导航已隐藏 · 将鼠标移到内容顶部即可呼出
            </div>
          )}
        </div>
      )}
    </>
  );
}
