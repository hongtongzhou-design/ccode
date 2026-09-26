import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { NAV_GROUPS, NAV_BOTTOM, type NavItem } from "../navigation";
import {
  INITIAL_NAV_ISLAND,
  isNavCapsuleItemVisible,
  normalizeNavCapsuleDelay,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  reconcileIsland,
  type NavIslandEvent,
} from "../nav-capsule";
import { NAV_ICONS } from "../navigation-icons";
import { announceLine, type RunAnnouncement } from "../run-announce";

const HINT_KEY = "ccode.navIslandHintSeen";

function pageTitle(item: NavItem, runningCount: number, inboxCount: number) {
  if (item.id === "terminal" && runningCount > 0)
    return `${item.label}（${runningCount} 个 agent 运行中）`;
  if (item.id === "workspaces" && inboxCount > 0)
    return `${item.label}（${inboxCount} 件待处理）`;
  return item.label;
}

/** 角标以计数为 key：数字一变就重播一次呼吸，当作计数变化的轻提示。 */
function IslandBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span key={count} className="ccode-top-nav-badge ccode-nav-island-badge">
      {count}
    </span>
  );
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
  announcement,
  onAnnouncementClick,
  onExpandedChange,
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
  /** 跑完/跑挂播报。只是一段文本，不是岛的第三态——宽度由休眠面自己量。 */
  announcement?: RunAnnouncement | null;
  onAnnouncementClick?: (item: RunAnnouncement) => void;
  /** 展开态变化时通知外层：标题栏两侧的上下文靠它让位。 */
  onExpandedChange?: (expanded: boolean) => void;
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

  const [island, dispatchIsland] = useReducer(
    reconcileIsland,
    INITIAL_NAV_ISLAND,
  );
  const expanded = island.phase === "expanded";
  /* 展开态报给外层：标题栏左右两侧的上下文（项目、运行数、⌘K、收件箱）要靠它让位。
     放在这里而不是让外层去读岛的 DOM 状态——岛自己在开，就该由岛说，外层不该反向
     去观察一个子元素长什么样。归位交给外层：岛只在 chromeHidden 时挂载，切回有
     侧栏时外层那一帧就把让位状态清了，这里不必再补一个卸载回调（两套机制描述同
     一件事，读的人还得判断哪个先跑）。 */
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  const [hintVisible, setHintVisible] = useState(false);
  const [dormantWidth, setDormantWidth] = useState(0);
  const [expandedWidth, setExpandedWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
  const timerRef = useRef<number | null>(null);
  const islandRef = useRef<HTMLElement>(null);
  const dormantRowRef = useRef<HTMLDivElement>(null);
  const expandedRowRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const send = (event: NavIslandEvent) => dispatchIsland(event);

  const clearHideTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 离开后等一会儿再收；收不收由状态机按「指针/焦点是否还在」当场决定。 */
  const collapseLater = () => {
    clearHideTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      send("delay-expired");
    }, delay);
  };

  const reveal = () => {
    clearHideTimer();
    send("pointer-enter");
  };

  const conceal = () => {
    clearHideTimer();
    send("close");
  };

  // Esc 收起。不做自定义 Tab 焦点环：岛在 DOM 顺序上排在页面内容之前，
  // 岛内最后一个按钮 Tab 出去自然进页面；焦点离开岛时 onBlur 会收起。
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    conceal();
  };

  const revealForKeyboard = () => {
    clearHideTimer();
    send("focus");
    window.requestAnimationFrame(() => {
      itemRefs.current["restore"]?.focus();
    });
  };

  // 换页不收起：早先有一条「换页即回休眠」的效应，理由是「不再占着顶部」——
  // 那是岛还浮在内容上方时的顾虑。岛现在嵌在标题栏里、不占内容，而连着切几页
  // 是常规操作，点一下就把岛收掉会把「接着看下一个入口」掐断。
  // 收不收仍由状态机按指针/焦点判：鼠标离开或焦点离开后照旧按 delay 收起。

  useEffect(() => {
    if (localStorage.getItem(HINT_KEY) === "1") return;
    localStorage.setItem(HINT_KEY, "1");
    setHintVisible(true);
    const id = window.setTimeout(() => setHintVisible(false), 3200);
    return () => window.clearTimeout(id);
  }, []);

  // 首次真正展开过就撤掉提示，不用纯计时器收尾
  useEffect(() => {
    if (hintVisible && expanded) setHintVisible(false);
  }, [hintVisible, expanded]);

  /* 岛收回休眠时，把「指针点出来的焦点」从展开面里摘掉。
     Chromium 点按钮会留下 DOM 焦点，展开面收起后它是 aria-hidden 的——
     焦点留在里面等于留了个看不见、却还能被 Enter/Space 触发的按钮。
     键盘焦点不在此列：它由 onBlur 自己交接，休眠态里也还要能继续 Tab。 */
  useEffect(() => {
    if (expanded) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!islandRef.current?.contains(active)) return;
    if (active.matches(":focus-visible")) return;
    active.blur();
  }, [expanded]);

  /* 两副面孔各量各的自然宽度，容器再按目标宽度做形变。
     量的是面孔内部的行（不受容器宽度约束），不是被夹住的容器本身——
     否则「容器宽度由量值决定、量值又被容器夹住」会形成自反馈环。 */
  useLayoutEffect(() => {
    const sync = () => {
      const d = dormantRowRef.current;
      const e = expandedRowRef.current;
      if (d) {
        const w = Math.ceil(d.getBoundingClientRect().width);
        const h = Math.ceil(d.getBoundingClientRect().height);
        setDormantWidth((prev) => (prev === w ? prev : w));
        setRowHeight((prev) => (prev === h ? prev : h));
      }
      if (e) {
        const w = Math.ceil(e.getBoundingClientRect().width);
        setExpandedWidth((prev) => (prev === w ? prev : w));
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (dormantRowRef.current) observer.observe(dormantRowRef.current);
    if (expandedRowRef.current) observer.observe(expandedRowRef.current);
    return () => observer.disconnect();
  });

  // 展开时把当前页滚进视野（窄窗口下展开面会被 max-width 夹住）
  useEffect(() => {
    if (!expanded) return;
    itemRefs.current[page]?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [page, expanded]);

  useEffect(() => clearHideTimer, []);

  const showIcon = mode !== "labels";
  const showLabel = mode !== "icons";
  const itemContent = (Icon: NavItem["Icon"], label: string) => (
    <>
      {showIcon && <Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
      {showLabel && <span>{label}</span>}
    </>
  );
  const badgeFor = (id: string) => (
    <>
      {id === "terminal" && <IslandBadge count={runningCount} />}
      {id === "workspaces" && <IslandBadge count={inboxCount} />}
    </>
  );

  /** 展开面的导航项。`interactive` 决定是否可聚焦——休眠时整面 aria-hidden 且不可 Tab。 */
  const navItems = (interactive: boolean) => (
    <>
      {showQuickChat && (
        <button
          ref={(el) => {
            itemRefs.current["quick-chat"] = el;
          }}
          type="button"
          tabIndex={interactive ? 0 : -1}
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
                tabIndex={interactive ? 0 : -1}
                onClick={() => onPage(item.id)}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={pageTitle(item, runningCount, inboxCount)}
                className={`ccode-top-nav-item shrink-0 ${active ? "ccode-top-nav-item-active" : ""}`}
              >
                {itemContent(item.Icon, item.label)}
                {badgeFor(item.id)}
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
            tabIndex={interactive ? 0 : -1}
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
    </>
  );

  /* 恢复侧栏在两副面孔里都排最前：全收起时它是唯一的退路，键盘第一下就够得着。

     休眠面**始终带文字**，不跟 displayMode 走：那个设置管的是展开态里那排导航项
     显示符号还是文字，而休眠面本来就只有一个控件、不是一排。只显示符号时休眠面
     会退回「一个孤零零的光图标」——看不出它是入口，也看不出悬停会展开整排导航。
     展开面仍按模式走，所以两副面孔的字有时不一样（仅符号时展开面只剩图标），
     这没问题：两副面孔是淡入淡出、各自量宽，不会同时在场。 */
  const restoreItem = (interactive: boolean, collapsedFace: boolean) => (
    <button
      ref={(el) => {
        itemRefs.current["restore"] = el;
      }}
      type="button"
      tabIndex={interactive ? 0 : -1}
      onClick={onRestore}
      aria-label="恢复侧栏"
      title="恢复侧栏"
      className={`ccode-top-nav-item shrink-0 ${
        collapsedFace ? "ccode-nav-island-restore" : ""
      }`}
    >
      {collapsedFace ? (
        <>
          <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>恢复侧栏</span>
        </>
      ) : (
        itemContent(PanelLeftOpen, "恢复侧栏")
      )}
    </button>
  );

  const hasNav = showQuickChat || groups.length > 0 || bottomItems.length > 0;
  /* 目标宽度直接取量值：.ccode-nav-island 是 content-box，padding 与边框长在外侧，
     量到多宽就写多宽。用 border-box 反而要在这里加上 4+4+1+1，改 CSS 就会错位。 */
  const targetWidth = expanded
    ? expandedWidth
      ? `min(${expandedWidth}px, calc(100vw - 24px))`
      : "calc(100vw - 24px)"
    : dormantWidth
      ? `${dormantWidth}px`
      : undefined;

  return (
    <>
      {/* 键盘唤出入口：展开面里的按钮本身可聚焦，这里给「Tab 从岛尾走回岛头」一个落点 */}
      <button
        type="button"
        className="ccode-nav-capsule-sentinel"
        aria-label="显示顶部导航"
        onFocus={revealForKeyboard}
      />
      {hintVisible && (
        <div className="ccode-nav-island-hint" role="status">
          侧栏已隐藏 · 顶部岛悬停展开导航
        </div>
      )}
      {/* 岛不用 .ccode-float-surface：它带的 ccode-pop 动画会写 transform: scale()，
          和岛自己的 translateX(-50%) 居中打架——入场那 150ms 会先偏右再弹回来。
          玻璃底、边框和内高光都在 .ccode-nav-island 里自带，不需要那个类。 */}
      <nav
        ref={islandRef}
        aria-label="全局导航"
        data-state={island.phase}
        className="ccode-nav-island"
        style={{
          width: targetWidth,
          // content-box：写的就是内容盒高度，上下 4px padding 与 1px 边框由 CSS 加在外侧
          height: rowHeight ? `${rowHeight}px` : undefined,
        }}
        onMouseEnter={reveal}
        onMouseLeave={() => {
          send("pointer-leave");
          collapseLater();
        }}
        onFocus={(e) => {
          clearHideTimer();
          /* 只把「键盘来的焦点」记为键盘停驻。Chromium 上鼠标点按钮同样会给它焦点，
             若照收，指针离开后 focused 仍为真，岛就再也不收了——这个差异只在
             WebView2 上现形（macOS 的 WKWebView 不给按钮焦点，所以看着是好的）。
             :focus-visible 正是按输入方式判定的：键盘为真、指针为假。
             指针路径不需要这里补什么：鼠标还在岛上时 pointerInside 本来就托着岛。 */
          if (e.target instanceof Element && e.target.matches(":focus-visible")) {
            send("focus");
          }
        }}
        onBlur={(e) => {
          if (
            e.relatedTarget instanceof Node &&
            islandRef.current?.contains(e.relatedTarget)
          )
            return;
          send("blur");
          collapseLater();
        }}
        onKeyDown={onKeyDown}
      >
        {/* 两副面孔绝对叠放：容器做宽高形变，面孔只做淡入淡出。
            这样不必给每个导航项做位移动画，切换时也不会互相挤压。 */}
        <div className="ccode-nav-island-face">
          {/* 休眠面只有「恢复侧栏」。先前并排放一个当前页高亮块，两个圆图标挤在
              小胶囊里读起来像开关，而且那个块点回当前页等于把页面设成它自己。
              当前页信息页头本来就有，不需要在岛上再报一次。 */}
          <div
            ref={dormantRowRef}
            className="ccode-nav-island-row ccode-nav-island-row-dormant"
            aria-hidden={expanded}
          >
            {restoreItem(!expanded, true)}
            {/* 播报贴着「恢复侧栏」排在后面，与它同处一行。不做成独立面孔：
                它是内容不是模式，为它加第三态就得再配一套宽高与过渡，
                而休眠面本来就由 ResizeObserver 按内容量宽——多一句话自己会长宽。 */}
            {announcement && (
              <button
                type="button"
                tabIndex={!expanded ? 0 : -1}
                onClick={() => onAnnouncementClick?.(announcement)}
                aria-label={announceLine(announcement)}
                title={`${announceLine(announcement)}（点击去运行）`}
                className={`ccode-nav-island-announce shrink-0 ${
                  announcement.outcome === "failed"
                    ? "ccode-nav-island-announce-failed"
                    : ""
                }`}
              >
                <span className="ccode-nav-island-announce-dot" aria-hidden="true" />
                {announceLine(announcement)}
              </button>
            )}
          </div>
          <div
            ref={expandedRowRef}
            className="ccode-nav-island-row ccode-nav-island-row-expanded"
            aria-hidden={!expanded}
          >
            {restoreItem(expanded, false)}
            {hasNav && (
              <span className="ccode-top-nav-separator" aria-hidden="true" />
            )}
            {navItems(expanded)}
          </div>
        </div>
      </nav>
    </>
  );
}
