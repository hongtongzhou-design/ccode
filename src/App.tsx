import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import ErrorBoundary from "./components/ErrorBoundary";
import CommandPalette from "./components/CommandPalette";
import QuickChatModal, {
  launchQuickChatDirect,
  quickChatSkipEnabled,
  resumeSessionInTerminal,
} from "./components/QuickChatModal";
import QuickChatHistoryMenu from "./components/QuickChatHistoryMenu";
import TopNavCapsule from "./components/TopNavCapsule";
import { pickQuickChatSessions } from "./quick-chat";
import { ConfirmDialogHost } from "./components/ConfirmDialog";
import { HoverTip, useHoverTip } from "./components/HoverTip";
import { LoadingRows, rowActionClass } from "./components/PageFrame";
import "./App.css";
import { useAppStore, runInboxAction } from "./store";
import { groupInbox, type InboxCategory } from "./inbox";
import { runDoneNotifyBody, runDoneNotifyTitle } from "./schedule-tasks";
import type { SchedulerRunDonePayload, SessionMetaDto } from "./types";
import {
  eventMatchesCombo,
  comboLabel,
  PAGE_HOTKEY_DEFS,
  IS_MAC,
  IS_WINDOWS,
} from "./hotkeys";
import { NAV_ICONS } from "./navigation-icons";
import { NAV_GROUPS, NAV_BOTTOM } from "./navigation";
import { normalizeNavCapsuleDelay, resolveStartupNavMode } from "./nav-capsule";

// 页面懒加载：首屏只拉当前页 chunk，其余页首次访问时才加载
const ProfilesPage = lazy(() => import("./pages/ProfilesPage"));
const McpPage = lazy(() => import("./pages/McpPage"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const SkillsPage = lazy(() => import("./pages/SkillsPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const TerminalPage = lazy(() => import("./pages/TerminalPage"));
const WorkspacesPage = lazy(() => import("./pages/WorkspacesPage"));
const WorkbenchPage = lazy(() => import("./pages/WorkbenchPage"));

function PageLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <LoadingRows />
    </div>
  );
}

/** 侧栏收起态的应用内 tooltip：展开态已有文字，不再重复弹提示。 */
function RailTooltip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref, false, true);
  return (
    <span
      ref={ref}
      className="block"
      onMouseEnter={collapsed ? show : undefined}
      onMouseLeave={collapsed ? hide : undefined}
      onFocus={collapsed ? show : undefined}
      onBlur={collapsed ? hide : undefined}
    >
      {children}
      {collapsed && <HoverTip tip={tip} text={label} side />}
    </span>
  );
}

/** 路径末段作项目名（通知标题用；与 WorkspacesPage pathBaseName 同口径） */
function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 定时雷达运行完成的系统通知：复用通知权限申请模式（首次系统级弹窗，被拒静默跳过）。
 *  遵守「长任务 OS 通知」设置开关（notificationsEnabled），不新增设置项。 */
async function fireScheduleNotification(
  title: string,
  body: string,
  extra: Record<string, unknown>,
) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ title, body, actionTypeId: "ccode.schedule", extra });
}

/** 页切顺序/逐页绑定/默认值的单一出处在 hotkeys.ts PAGE_HOTKEY_DEFS（与侧栏工作→能力→管理一致） */

function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.navCollapsed);
  const cycleNavState = useAppStore((s) => s.cycleNavState);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const exitChromeHidden = useAppStore((s) => s.exitChromeHidden);
  const toggleChromeHidden = useAppStore((s) => s.toggleChromeHidden);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 「快速开聊」弹层：侧栏常驻入口与 ⌘K 命令共用同一个宿主
  const [quickChatOpen, setQuickChatOpen] = useState(false);
  // 侧栏「快速开聊」右键 = 随手聊历史浮层（v3.93 用户拍板）：勾了「下次直接开聊」的用户
  // 左键直达终端、永远看不到弹层里的历史区，右键浮层是她们的回看口；
  // 只列随手聊会话（不落工作区/已注册项目），与弹层「随手聊历史」同一口径
  const [quickChatMenu, setQuickChatMenu] = useState<{
    x: number;
    y: number;
    sessions: SessionMetaDto[] | null;
  } | null>(null);
  /** 右键先弹读取中浮层，数据到达即替换（list_sessions 有 10s 缓存、list_projects 本地读） */
  function openQuickChatMenu(e: React.MouseEvent) {
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    setQuickChatMenu({ x, y, sessions: null });
    void (async () => {
      try {
        const [all, projects] = await Promise.all([
          invoke<SessionMetaDto[]>("list_sessions"),
          invoke<{ path: string }[]>("list_projects"),
        ]);
        const sessions = pickQuickChatSessions(
          all,
          projects.map((p) => p.path),
          undefined,
          IS_WINDOWS,
        );
        setQuickChatMenu((cur) => (cur ? { ...cur, sessions } : cur));
      } catch {
        setQuickChatMenu((cur) => (cur ? { ...cur, sessions: [] } : cur));
      }
    })();
  }
  // 运行状态镜像（任意页面可见）：顶栏显示总数，侧栏只在运行页显示提示。
  const terminalRunInputs = useAppStore((s) => s.terminalRunInputs);
  const runningCount = useAppStore((s) => Object.keys(s.liveSessions).length);
  const visibleRunningCount = terminalRunInputs.filter((input) => input.running)
    .length || runningCount;
  // 「待你处理」收件箱条目镜像（WorkspacesPage 写入）：侧栏圆点计数 + macOS 标题栏收件箱共用
  const inboxItems = useAppStore((s) => s.inboxItems);
  const inboxCount = inboxItems.length;
  const contextLabel = useAppStore((s) => s.contextLabel);
  const dismissHelpRequest = useAppStore((s) => s.dismissHelpRequest);
  const dismissInbox = useAppStore((s) => s.dismissInbox);
  // 类别胶囊：按 key 前缀分组（固定顺序，空类不渲染）
  const inboxGroups = groupInbox(inboxItems);
  // 标题栏收件箱的展开态：当前展开的类别（Ghostty 式下拉；遮罩/Esc/再点关闭）
  const [titleInboxCat, setTitleInboxCat] = useState<InboxCategory | null>(null);
  // 展开中的类别被清空（如最后一条 help 被忽略）时收起下拉
  useEffect(() => {
    if (
      titleInboxCat !== null &&
      !inboxGroups.some((g) => g.category === titleInboxCat)
    )
      setTitleInboxCat(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleInboxCat, inboxItems]);
  useEffect(() => {
    if (titleInboxCat === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTitleInboxCat(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [titleInboxCat]);
  const loadAll = useAppStore((s) => s.loadAll);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadRecentRepos = useAppStore((s) => s.loadRecentRepos);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);

  // 记录访问过的页面：懒加载的页面首次访问后才挂载，之后保持挂载（切回状态不丢、终端不断线）
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set([page]),
  );
  useEffect(() => {
    setVisited((v) => (v.has(page) ? v : new Set(v).add(page)));
  }, [page]);

  // 侧栏收展完全由用户手动控制（品牌区点击）；曾有的按页面自动收展被用户否决（v3.43）

  // 全局快捷键（设置页可自定义，存 settings.json）：命令面板（默认 ⌘K）、
  // 隐藏/显示侧栏（默认 ⌘\）、页切逐页绑定（默认 ⌘1–⌘9，hotkeyPages 按页覆盖 + 整组总开关）。
  // 空串 = 禁用；⌘F 已被终端搜索占用故不用。
  const settings = useAppStore((s) => s.settings);
  const navCapsuleDelay = normalizeNavCapsuleDelay(
    settings?.navCapsuleHideDelayMs,
  );
  // 顶栏命令面板入口的键位标签：跟随设置页自定义绑定；禁用（空串）时回落默认展示
  const paletteComboLabel = comboLabel(settings?.hotkeyPalette || "mod+k");
  useEffect(() => {
    const paletteCombo = settings?.hotkeyPalette ?? "mod+k";
    const chromeCombo = settings?.hotkeyHideChrome ?? "mod+\\";
    const pageSwitchOn = settings?.hotkeyPageSwitch !== false;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (isEditable) return;
      if (eventMatchesCombo(e, paletteCombo)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (paletteOpen) return;
      if (eventMatchesCombo(e, chromeCombo)) {
        e.preventDefault();
        toggleChromeHidden();
        return;
      }
      // 页切：逐页绑定（缺省回落默认 mod+1..9），冲突由设置页录制时拒绝兜底
      if (pageSwitchOn) {
        const hit = PAGE_HOTKEY_DEFS.find((p) =>
          eventMatchesCombo(e, settings?.hotkeyPages?.[p.id] ?? p.combo),
        );
        if (hit) {
          e.preventDefault();
          setPage(hit.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPage, toggleChromeHidden, settings]);

  // 通知动作：注册「去处理」按钮类型；点击后聚焦对应终端标签（通知只有「待确认」一种），
  // 无 extra（旧通知）→ 回首页收件箱。横幅样式不显按钮（系统设置决定），正文点击走系统默认激活。
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);
  useEffect(() => {
    let unregister: (() => void) | undefined;
    registerActionTypes([
      {
        id: "ccode.attention",
        actions: [{ id: "open", title: "去处理", foreground: true }],
      },
      {
        id: "ccode.schedule",
        actions: [{ id: "open", title: "去查看", foreground: true }],
      },
    ]).catch(() => {});
    onAction((notification) => {
      getCurrentWindow()
        .setFocus()
        .catch(() => {});
      const extra = (notification.extra ?? {}) as {
        tabId?: string;
        cwd?: string;
        projectRoot?: string;
        focus?: "lit" | "schedule";
      };
      void (async () => {
        if (extra.tabId) {
          setPage("terminal");
          setFocusTabReq(extra.tabId);
          return;
        }
        if (extra.projectRoot) {
          useAppStore.getState().setSelectProjectReq(extra.projectRoot);
          useAppStore.getState().setProjectFocusReq({
            projectRoot: extra.projectRoot,
            focus: extra.focus ?? "schedule",
            token: Date.now(),
          });
          setPage("workspaces");
          return;
        }
        setPage("workspaces");
      })();
    })
      .then((listener) => {
        unregister = () => listener.unregister();
      })
      .catch(() => {});
    return () => unregister?.();
  }, [setPage, setFocusTabReq]);

  // 定时雷达运行完成 → OS 通知（scheduler.rs 的 scheduler-run-done；summary 后端已脱敏）。
  // 只负责通知：工作区页 ScheduleSection 自行监听同一事件刷新列表。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<SchedulerRunDonePayload>("scheduler-run-done", (e) => {
      const enabled = useAppStore.getState().settings?.notificationsEnabled ?? true;
      if (!enabled) return;
      void fireScheduleNotification(
        runDoneNotifyTitle(
          baseName(e.payload.projectRoot),
          e.payload.status,
          e.payload.scheduleName || (e.payload.skill === "lit-watch" ? "文献雷达" : "定时任务"),
        ),
        runDoneNotifyBody(e.payload.summary),
        {
          projectRoot: e.payload.projectRoot,
          scheduleId: e.payload.scheduleId,
          skill: e.payload.skill,
          focus: e.payload.skill === "lit-watch" ? "lit" : "schedule",
        },
      );
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // 启动页与导航形态（设置页可选）：设置载入后只应用一次，之后用户手动切换不受影响。
  const startPageAppliedRef = useRef(false);
  useEffect(() => {
    if (startPageAppliedRef.current || !settings) return;
    startPageAppliedRef.current = true;
    const target = settings.startPage;
    if (target && target !== page) setPage(target);
    const legacyCollapsed = localStorage.getItem("ccode.navCollapsed") === "1";
    const mode = resolveStartupNavMode(settings.startupNavMode, legacyCollapsed);
    const store = useAppStore.getState();
    if (mode === "hidden") {
      store.enterChromeHidden();
    } else {
      store.setNavCollapsed(mode === "collapsed");
      if (store.chromeHidden) store.exitChromeHidden();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    loadAll().catch((e) => console.error(e));
    loadSessions().catch((e) => console.error(e));
    loadRecentRepos().catch(() => {});
    // 设置（含主题）在启动时加载并应用
    loadSettings().catch((e) => console.error(e));
    // 启动时静默检查应用更新（内部已吞错，命中后在设置页「更新」分区提示）
    checkAppUpdate().catch(() => {});
  }, [loadAll, loadSessions, loadRecentRepos, loadSettings, checkAppUpdate]);

  // 前端未捕获异常上报到进程内日志缓冲（设置页「诊断」可见）；同消息 5s 去重防刷屏
  useEffect(() => {
    const last = new Map<string, number>();
    const report = (source: string, message: string) => {
      const now = Date.now();
      if (now - (last.get(message) ?? 0) < 5000) return;
      last.set(message, now);
      // 顺手淘汰 1 分钟前的旧条目，避免 Map 只增不清
      for (const [m, t] of last) {
        if (now - t > 60_000) last.delete(m);
      }
      invoke("log_event", { level: "error", source, message }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => {
      report("onerror", `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      report(
        "unhandledrejection",
        r instanceof Error ? (r.stack ?? r.message) : String(r),
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // 跨实例同步：窗口重新聚焦/可见时重拉配置、设置与会话（2s 节流）。
  // 双开场景（worktree 演示）里另一个实例的改动能即时反映过来。
  useEffect(() => {
    let last = 0;
    const sync = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      loadAll().catch(() => {});
      loadSettings().catch(() => {});
      loadSessions().catch(() => {});
      loadRecentRepos().catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadAll, loadSessions, loadRecentRepos, loadSettings]);

  return (
    <ErrorBoundary>
      <div className="ccode-app-shell relative flex h-full flex-col overflow-hidden bg-rail text-l2">
        {/* macOS 自绘标题栏（titleBarStyle: Overlay + hiddenTitle）：纯拖拽区 +
            Ghostty 式标题栏收件箱（按类别拆胶囊，点胶囊向下展开该类明细，遮罩/Esc/再点关闭）。
            窗口标题不在界面渲染（用户拍板删除，标题字符串仍保留在 tauri 配置里供自动化定位窗口）。
            Windows/Linux 用原生标题栏；客户端上下文栏仍统一承载项目、运行、命令面板与收件箱。
            执行态（chromeHidden）下也必须保留这条栏：Overlay 模式下红绿灯按钮始终悬浮在
            左上角，栏的 pl-[78px] 负责让位；整条隐藏会导致按钮压住页面内容、胶囊消失。
            执行态只省略底部分隔线，栏体保留以承接红绿灯与收件箱胶囊。 */}
        <header
          data-tauri-drag-region={IS_MAC ? true : undefined}
          className={`ccode-titlebar flex h-10 shrink-0 items-center gap-2.5 bg-rail pr-3 ${
            IS_MAC ? "pl-[78px]" : "pl-3"
          } ${chromeHidden ? "" : "border-b border-hairline"}`}
        >
            {/* 全局上下文栏：macOS Overlay 与 Windows/Linux 原生标题栏都承载。
                左=我在哪、右=在跑什么 + 等我处理什么。
                命令面板只保留这里一个可见入口，输入框仍只在面板打开后出现。
                执行态（⌘\）下左中两段隐藏，只留红绿灯让位与收件箱胶囊。 */}
            {!chromeHidden && (
              <>
                <button
                  type="button"
                  onClick={() => setPage("workspaces")}
                  title={
                    contextLabel
                      ? `当前项目：${contextLabel.project}（点击回项目页）`
                      : "还没有选中项目"
                  }
                  className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
                >
                  <NAV_ICONS.workspaces
                    size={14}
                    strokeWidth={1.8}
                    className="shrink-0 text-l4"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">
                    {contextLabel?.project ?? "Ccode"}
                  </span>
                  {contextLabel?.step && (
                    <>
                      <span className="shrink-0 text-l4">·</span>
                      <span className="min-w-0 truncate">{contextLabel.step}</span>
                    </>
                  )}
                </button>
                {visibleRunningCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setPage("terminal")}
                    title={`${visibleRunningCount} 个 agent 正在运行（点击去运行）`}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
                  >
                    <span className="text-l4">⑂</span>
                    {visibleRunningCount} 运行中
                  </button>
                )}
              </>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                title={`打开命令面板（${paletteComboLabel}）`}
                aria-label="打开命令面板"
                className="flex h-6 items-center gap-1.5 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                <span className="font-mono">{paletteComboLabel}</span>
                <span className="hidden sm:inline">命令面板</span>
              </button>
              {inboxGroups.length > 0 && (
                <div className="relative flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setTitleInboxCat((v) => (v ? null : inboxGroups[0].category))
                    }
                    aria-expanded={titleInboxCat !== null}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-micro text-l3 hover:bg-hover hover:text-l1"
                    title="待处理"
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${inboxGroups[0].items[0].dot}`}
                    />
                    {inboxCount}
                    <span className="text-l4">
                      {titleInboxCat !== null ? "▴" : "▾"}
                    </span>
                  </button>
                  {titleInboxCat !== null && (
                    <ul className="absolute right-0 top-full z-40 mt-1.5 max-h-80 w-[360px] max-w-[80vw] space-y-2 overflow-auto rounded-md border border-field ccode-float-surface p-1">
                      {inboxGroups.map((group) => (
                        <li key={group.category}>
                          <div className="px-2.5 py-1 text-micro text-l4">
                            {group.label} {group.items.length}
                          </div>
                          {group.items.map((item) => (
                          <div
                            key={item.key}
                            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs hover:bg-hover"
                          >
                            <span
                              className={`size-2 shrink-0 rounded-full ${item.dot}`}
                            />
                            <span className="min-w-0 flex-1 truncate text-l2">
                              {item.text}
                            </span>
                            {/* 忽略：help: 走原有的按来源屏蔽，其余六类走通用条目屏蔽
                                （v3.88；两者都以「状态变化即复现」为口径，忽略 ≠ 漏掉） */}
                            <button
                              type="button"
                              title="忽略（状态变化后会重新出现）"
                              onClick={() =>
                                item.key.startsWith("help:")
                                  ? dismissHelpRequest(
                                      item.key.slice("help:".length),
                                      item.dismissSignature ?? "",
                                    )
                                  : dismissInbox(item)
                              }
                              className="shrink-0 text-l4 hover:text-l1"
                            >
                              ✕
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setTitleInboxCat(null);
                                runInboxAction(item);
                              }}
                              className={rowActionClass}
                            >
                              {item.actionLabel}
                            </button>
                          </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
        </header>
        {chromeHidden && (
          <TopNavCapsule
            page={page}
            onPage={setPage}
            onQuickChat={() => {
              if (quickChatSkipEnabled()) {
                void launchQuickChatDirect().then((ok) => {
                  if (!ok) setQuickChatOpen(true);
                });
              } else {
                setQuickChatOpen(true);
              }
            }}
            onQuickChatContextMenu={(e) => void openQuickChatMenu(e)}
            onRestore={exitChromeHidden}
            runningCount={visibleRunningCount}
            inboxCount={inboxCount}
            hideDelayMs={navCapsuleDelay}
            displayMode={settings?.navCapsuleDisplayMode}
            visibleItems={settings?.navCapsuleVisibleItems}
          />
        )}
        {titleInboxCat !== null && (
          <div
            className="fixed inset-0 z-20"
            onClick={() => setTitleInboxCat(null)}
          />
        )}
        <div className="flex min-h-0 flex-1">
        {/* 执行态（⌘\）：侧栏整体隐藏，页面 chrome 让位给终端/评审 */}
        {!chromeHidden && (
        <aside
          className={`ccode-app-rail flex shrink-0 flex-col border-r border-hairline bg-rail transition-[width] duration-150 ${
            collapsed ? "w-14" : "w-48"
          }`}
        >
          {/* 品牌区在展开与图标侧栏之间切换；完全隐藏由 ⌘\\、命令面板或顶部胶囊控制。 */}
          <button
            type="button"
            onClick={cycleNavState}
            title={collapsed ? "展开侧栏" : "收起为图标"}
            className={`ccode-brand-bar flex h-12 shrink-0 select-none items-center text-left text-l1 ${
              collapsed ? "justify-center text-sm" : "px-3"
            }`}
          >
            {collapsed ? (
              <span className="text-lg font-semibold">C</span>
            ) : (
              <span className="block min-w-0 text-lg font-semibold tracking-wide">
                Ccode
              </span>
            )}
          </button>

          <nav className="ccode-app-nav min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2">
            {NAV_GROUPS.map((group, groupIndex) => (
              <div key={group.label} className={groupIndex > 0 ? "mt-3" : ""}>
                {!collapsed && (
                  <div className="mb-1 mt-1 px-2 text-micro font-medium tracking-[0.08em] text-l3">
                    {group.label}
                  </div>
                )}
                {/* 「快速开聊」是动作不是页面：放在「工作」组首位，回答「我就想随便聊聊」——
                    其余入口全是项目/流程优先，进来先要建项目太重。
                    弹层里勾过「下次直接开聊」就跳过弹层直接落终端（记住上次选择），
                    ⌘K 入口永远开弹层，留作调整口；右键 = 随手聊历史浮层（跳过弹层的用户
                    左键看不到历史，右键是她们的回看口） */}
                {group.label === "工作" && (
                  <RailTooltip label="快速开聊" collapsed={collapsed}>
                    <button
                      type="button"
                      onClick={() => {
                        if (quickChatSkipEnabled()) {
                          void launchQuickChatDirect().then((ok) => {
                            if (!ok) setQuickChatOpen(true);
                          });
                        } else {
                          setQuickChatOpen(true);
                        }
                      }}
                      onContextMenu={(e) => void openQuickChatMenu(e)}
                      aria-label="快速开聊"
                      title="快速开聊：不建项目直接开一个终端标签（右键看随手聊历史）"
                      className={`relative mb-0.5 flex h-7 w-full items-center rounded-md text-sm text-l3 transition-colors hover:bg-hover hover:text-l2 ${
                        collapsed ? "justify-center" : "px-2.5"
                      }`}
                    >
                      <NAV_ICONS.quickChat
                        size={16}
                        strokeWidth={1.8}
                        className={collapsed ? "" : "mr-2 shrink-0"}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="truncate">快速开聊</span>}
                    </button>
                  </RailTooltip>
                )}
                {group.items.map((n) => (
                  <RailTooltip key={n.id} label={n.label} collapsed={collapsed}>
                    <button
                      type="button"
                      onClick={() => setPage(n.id)}
                      aria-current={page === n.id ? "page" : undefined}
                      aria-label={n.label}
                      title={
                        n.id === "terminal" && visibleRunningCount > 0
                          ? `${n.label}（${visibleRunningCount} 个 agent 运行中）`
                          : n.id === "workspaces" && inboxCount > 0
                            ? `${n.label}（${inboxCount} 件待处理）`
                            : n.label
                      }
                      className={`relative mb-0.5 flex h-8 w-full items-center rounded-md text-sm transition-colors ${
                        collapsed ? "justify-center" : "px-2.5"
                      } ${
                        page === n.id
                          ? "bg-rail-sel text-l1"
                          : "text-l3 hover:bg-hover hover:text-l2"
                      }`}
                    >
                      <n.Icon
                        size={16}
                        strokeWidth={1.8}
                        className={`${collapsed ? "" : "mr-2 shrink-0"} ${page === n.id ? "text-nav-accent" : ""}`}
                        aria-hidden="true"
                      />
                      {!collapsed && <span className="truncate">{n.label}</span>}
                    </button>
                  </RailTooltip>
                ))}
              </div>
            ))}
          </nav>

          {/* 底部管理区与导航之间只留一根隐约细线（5% 白 + 0.5px），不完全消失 */}
          <div className="shrink-0 border-t border-white/5 px-1.5 py-2">
            {NAV_BOTTOM.map((n) => (
              <RailTooltip key={n.id} label={n.label} collapsed={collapsed}>
                <button
                  type="button"
                  onClick={() => setPage(n.id)}
                  aria-current={page === n.id ? "page" : undefined}
                  aria-label={n.label}
                  title={n.label}
                  className={`relative mb-0.5 flex h-7 items-center rounded-md text-sm transition-colors ${
                    collapsed ? "w-11 justify-center" : "w-full px-2.5"
                  } ${
                    page === n.id
                      ? "bg-rail-sel text-l1"
                      : "text-l3 hover:bg-hover hover:text-l2"
                  }`}
                >
                  <n.Icon
                    size={16}
                    strokeWidth={1.8}
                    className={`${collapsed ? "" : "mr-2 shrink-0"} ${page === n.id ? "text-nav-accent" : ""}`}
                    aria-hidden="true"
                  />
                  {!collapsed && <span>{n.label}</span>}
                </button>
              </RailTooltip>
            ))}
          </div>
        </aside>
        )}
        <main className="ccode-app-main h-full min-h-0 min-w-0 flex-1">
          {/* 页面保持挂载，切换标签不销毁终端；未访问过的页不挂载（懒加载） */}
          <div className={page === "workbench" ? "h-full overflow-auto" : "hidden"}>
            {visited.has("workbench") && (
              <Suspense fallback={<PageLoading />}>
                <WorkbenchPage
                  visible={page === "workbench"}
                  onQuickChat={() => setQuickChatOpen(true)}
                />
              </Suspense>
            )}
          </div>
          <div
            className={page === "profiles" ? "h-full overflow-auto" : "hidden"}
          >
            {visited.has("profiles") && (
              <Suspense fallback={<PageLoading />}>
                <ProfilesPage visible={page === "profiles"} />
              </Suspense>
            )}
          </div>
          <div className={page === "workspaces" ? "h-full" : "hidden"}>
            {visited.has("workspaces") && (
              <Suspense fallback={<PageLoading />}>
                <WorkspacesPage visible={page === "workspaces"} />
              </Suspense>
            )}
          </div>
          <div className={page === "terminal" ? "h-full" : "hidden"}>
            {visited.has("terminal") && (
              <Suspense fallback={<PageLoading />}>
                <TerminalPage visible={page === "terminal"} />
              </Suspense>
            )}
          </div>
          <div className={page === "sessions" ? "h-full" : "hidden"}>
            {visited.has("sessions") && (
              <Suspense fallback={<PageLoading />}>
                <SessionsPage visible={page === "sessions"} />
              </Suspense>
            )}
          </div>
          <div className={page === "skills" ? "h-full" : "hidden"}>
            {visited.has("skills") && (
              <Suspense fallback={<PageLoading />}>
                <SkillsPage visible={page === "skills"} />
              </Suspense>
            )}
          </div>
          <div className={page === "mcp" ? "h-full overflow-auto" : "hidden"}>
            {visited.has("mcp") && (
              <Suspense fallback={<PageLoading />}>
                <McpPage visible={page === "mcp"} />
              </Suspense>
            )}
          </div>
          <div className={page === "stats" ? "h-full overflow-auto" : "hidden"}>
            {visited.has("stats") && (
              <Suspense fallback={<PageLoading />}>
                <StatsPage visible={page === "stats"} />
              </Suspense>
            )}
          </div>
          <div
            className={page === "settings" ? "h-full overflow-auto" : "hidden"}
          >
            {visited.has("settings") && (
              <Suspense fallback={<PageLoading />}>
                <SettingsPage visible={page === "settings"} />
              </Suspense>
            )}
          </div>
        </main>
        </div>
        {paletteOpen && (
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            onQuickChat={() => setQuickChatOpen(true)}
          />
        )}
        {quickChatOpen && (
          <QuickChatModal onClose={() => setQuickChatOpen(false)} />
        )}
        {quickChatMenu && (
          <QuickChatHistoryMenu
            x={quickChatMenu.x}
            y={quickChatMenu.y}
            sessions={quickChatMenu.sessions}
            onPick={resumeSessionInTerminal}
            onClose={() => setQuickChatMenu(null)}
          />
        )}
        {/* 全局确认框宿主（confirmDialog）：z-[70]，压过一切覆盖层 */}
        <ConfirmDialogHost />
      </div>
    </ErrorBoundary>
  );
}

export default App;
