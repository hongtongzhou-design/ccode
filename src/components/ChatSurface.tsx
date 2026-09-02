import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import ConversationView from "./ConversationView";
import ChatComposer from "./ChatComposer";
import type {
  ChatMessageDto,
  ComboSurfaceDto,
  DetectResult,
  McpServerDto,
  SessionSyncState,
  SkillDto,
} from "../types";
import { IS_WINDOWS } from "../hotkeys";
import { dropHitsRect, joinDroppedChatPaths } from "../terminal-input";
import {
  approvalExtraHint,
  chatWaitKind,
  chatWaitText,
  latestToolName,
  modelSwitchCommand,
  slashHandoff,
} from "../chat-handoff";

export default function ChatSurface({
  messages,
  state,
  syncState,
  title,
  loading,
  active = true,
  agentId,
  confirmDetail,
  agentName,
  model,
  cwd,
  running,
  canResume,
  attention,
  forkAvailable,
  readOnly,
  readonlySupported,
  busy,
  skills,
  mcps,
  onSend,
  onFork,
  onAllowWrite,
  onOpenTerminal,
  onOpenMcp,
  onOpenHistory,
  onInterrupt,
  onApprovalKey,
  peek = false,
  onTogglePeek,
  onRequestPeek,
  modelSwitch,
  effort,
  profileModels = [],
  profileId,
  launchModel,
  hooksEnabled = false,
  ptyAlive = false,
  onWriteCommand,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  messages: ChatMessageDto[];
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  title: string | null;
  loading: boolean;
  /** 聊天层当前可见（常驻挂载仅隐藏后，用作输入框聚焦信号） */
  active?: boolean;
  agentId?: string | null;
  confirmDetail?: string | null;
  agentName?: string | null;
  model?: string | null;
  cwd?: string | null;
  running: boolean;
  canResume: boolean;
  attention: "done" | "working" | "confirm" | null;
  forkAvailable: boolean;
  readOnly: boolean;
  readonlySupported: boolean;
  busy?: boolean;
  skills: SkillDto[];
  mcps: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  onFork: () => void;
  onAllowWrite: () => void;
  onOpenTerminal: () => void;
  onOpenMcp: () => void;
  onOpenHistory?: () => void;
  onInterrupt?: () => void;
  onApprovalKey?: (key: "y" | "n" | "esc") => void;
  peek?: boolean;
  onTogglePeek?: () => void;
  onRequestPeek?: () => void;
  modelSwitch?: DetectResult["modelSwitch"];
  effort?: DetectResult["effort"];
  profileModels?: string[];
  profileId?: string | null;
  launchModel?: string | null;
  hooksEnabled?: boolean;
  ptyAlive?: boolean;
  onWriteCommand?: (cmd: string, opts?: { peek?: boolean }) => void;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);
  const [stuckWaiting, setStuckWaiting] = useState(false);
  const [seedInsert, setSeedInsert] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [combo, setCombo] = useState<ComboSurfaceDto | null>(null);
  const [comboReady, setComboReady] = useState(false);
  const prevScrollHeightRef = useRef(0);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    if (!(running && syncState === "waiting" && messages.length === 0)) {
      setStuckWaiting(false);
      return;
    }
    const t = setTimeout(() => setStuckWaiting(true), 8000);
    return () => clearTimeout(t);
  }, [running, syncState, messages.length]);

  useEffect(() => {
    if (stuckWaiting) onRequestPeek?.();
  }, [stuckWaiting, onRequestPeek]);

  function scrollBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setHasNew(false);
    el.scrollTop = el.scrollHeight;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (loadingOlderRef.current) {
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      el.scrollTop += delta;
      loadingOlderRef.current = false;
      return;
    }
    if (followRef.current) requestAnimationFrame(scrollBottom);
    else setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      if (
        !dropHitsRect(
          event.payload.position,
          rect,
          window.devicePixelRatio || 1,
        )
      ) {
        return;
      }
      const text = joinDroppedChatPaths(event.payload.paths, IS_WINDOWS);
      if (!text) return;
      if (!cancelled) setSeedInsert(text);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (!profileId || !launchModel) {
      setCombo(null);
      setComboReady(true);
      return;
    }
    let cancelled = false;
    setComboReady(false);
    invoke<ComboSurfaceDto>("combo_surface", {
      profileId,
      model: launchModel,
    })
      .then((value) => {
        if (!cancelled) {
          setCombo(value);
          setComboReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCombo(null);
          setComboReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, profileId, launchModel]);

  const tabKey = `${agentId ?? ""}:${profileId ?? ""}:${cwd ?? ""}`;
  const lastTabKey = useRef(tabKey);
  if (lastTabKey.current !== tabKey) {
    lastTabKey.current = tabKey;
    setModelOverride(null);
  }
  const shownModel = modelOverride ?? model ?? "";
  const effortLive =
    comboReady && combo?.showNativeEffort === true ? effort : null;
  const effortLevels = effortLive?.levels ?? [];

  function statusText() {
    if (state === "detecting" || syncState === "detecting") return "识别会话";
    if (state === "timeout" && canResume) return "可恢复";
    if (state === "timeout") return "等待会话文件";
    if (syncState === "waiting") return "等待会话文件";
    if (syncState === "polling") return running ? "同步中" : "已结束 · 可继续";
    if (syncState === "watching") return running ? "实时同步" : "已结束 · 可继续";
    if (state === "linked") return running ? "实时同步" : "已结束 · 可继续";
    return running ? "Agent 运行中" : "准备开始";
  }

  const canSend = state !== "timeout" || running || canResume;
  const statusClass =
    attention === "confirm"
      ? "bg-warn-text"
      : running
        ? "bg-ok-text animate-pulse-brief"
        : "bg-l4";
  const shortCwd = cwd ? cwd.replace(/^.*[\\/]/, "") : null;
  const toolName = latestToolName(messages);
  const waitKind = chatWaitKind({
    pendingReply: loading,
    running,
    syncState,
    messageCount: messages.length,
    stuckWaiting,
    toolName,
  });
  const waitText = chatWaitText(waitKind, toolName);
  const extraHint = approvalExtraHint(agentId, hooksEnabled);

  async function sendFromComposer(text: string): Promise<string | null> {
    const event = slashHandoff(text, modelSwitch?.kind ?? null);
    if (event === "picker_model") onRequestPeek?.();
    return onSend(text);
  }

  function pickModel(next: string) {
    setModelMenuOpen(false);
    if (!modelSwitch || !onWriteCommand) return;
    if (modelSwitch.kind === "direct") {
      onWriteCommand(modelSwitchCommand(modelSwitch.command, next, agentId));
      setModelOverride(next);
      return;
    }
    onWriteCommand(modelSwitch.command, { peek: true });
  }

  function pickEffort(level: string) {
    setEffortMenuOpen(false);
    if (!effortLive || !onWriteCommand) return;
    onWriteCommand(effortLive.command.replace("{level}", level));
  }

  return (
    <div
      ref={rootRef}
      data-chat-drop="1"
      className="flex h-full min-h-0 w-full flex-col bg-canvas"
    >
      <header className="shrink-0 border-b border-hairline bg-canvas/95 px-3 py-1.5 backdrop-blur-sm">
        <div className="flex w-full items-center gap-3 px-2">
          <span className={`size-2 shrink-0 rounded-full ${statusClass}`} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-medium text-l1">
                {title || "当前聊天"}
              </h1>
              <span className="shrink-0 text-micro text-l4">{statusText()}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-micro text-l4">
              {agentName && <span>{agentName}</span>}
              {shownModel && modelSwitch && profileModels.length > 0 ? (
                <>
                  <span>·</span>
                  <span className="relative inline-flex">
                    <button
                      type="button"
                      disabled={!ptyAlive}
                      onClick={() => setModelMenuOpen((v) => !v)}
                      title={
                        modelSwitch.kind === "picker"
                          ? "打开终端里的模型选择器"
                          : "切换模型（写入当前会话）"
                      }
                      className="rounded-sm px-1 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
                    >
                      {shownModel} ▾
                    </button>
                    {modelMenuOpen && (
                      <>
                        <button
                          type="button"
                          aria-label="关闭模型菜单"
                          className="fixed inset-0 z-40 cursor-default"
                          onClick={() => setModelMenuOpen(false)}
                        />
                        <ul className="absolute top-full left-0 z-50 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-field bg-raised p-1">
                          {profileModels.map((item) => (
                            <li key={item}>
                              <button
                                type="button"
                                onClick={() => pickModel(item)}
                                className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left font-mono text-micro text-l2 hover:bg-hover hover:text-l1"
                              >
                                {item}
                                {modelSwitch.kind === "picker" && (
                                  <span className="ml-auto text-l4">
                                    （打开选择器）
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </span>
                </>
              ) : shownModel ? (
                <>
                  <span>·</span>
                  <span>{shownModel}</span>
                </>
              ) : null}
              {effortLive && running && effortLevels.length > 0 && (
                <span className="relative inline-flex">
                  <button
                    type="button"
                    disabled={!ptyAlive}
                    onClick={() => setEffortMenuOpen((v) => !v)}
                    title="切换思考档位"
                    className="rounded-sm px-1 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-40"
                  >
                    ◈ 思考 ▾
                  </button>
                  {effortMenuOpen && (
                    <>
                      <button
                        type="button"
                        aria-label="关闭思考档菜单"
                        className="fixed inset-0 z-40 cursor-default"
                        onClick={() => setEffortMenuOpen(false)}
                      />
                      <ul className="absolute top-full left-0 z-50 mt-1 w-28 overflow-auto rounded-md border border-field bg-raised p-1">
                        {effortLevels.map((level) => (
                          <li key={level}>
                            <button
                              type="button"
                              onClick={() => pickEffort(level)}
                              className="flex w-full rounded-sm px-2 py-1 text-left font-mono text-micro text-l2 hover:bg-hover hover:text-l1"
                            >
                              {level}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </span>
              )}
              {shortCwd && (
                <>
                  <span>·</span>
                  <span className="truncate">{shortCwd}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {running && onInterrupt && (
              <button
                type="button"
                onClick={onInterrupt}
                title="打断当前生成（等效终端里按 Ctrl+C）"
                className="rounded-md px-2 py-1 text-micro text-warn-text hover:bg-hover"
              >
                ⏹ 打断
              </button>
            )}
            {onTogglePeek && (
              <button
                type="button"
                onClick={onTogglePeek}
                title="在聊天下方露出同一会话的终端画面，不改变终端行列数"
                className={`rounded-md px-2 py-1 text-micro hover:bg-hover ${
                  peek ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                }`}
              >
                {peek ? "收起终端" : "窥视终端"}
              </button>
            )}
            {readOnly && (
              <span
                className="rounded-md bg-inset px-2 py-1 text-micro text-warn-text"
                title={
                  readonlySupported
                    ? "该分叉会话启用了 Agent 原生只读/计划模式"
                    : "该 Agent 没有原生只读参数，仅提供提示约束"
                }
              >
                只读分叉
              </span>
            )}
            {readOnly && (
              <button
                type="button"
                onClick={onAllowWrite}
                className="rounded-md px-2 py-1 text-micro text-warn-text hover:bg-hover"
              >
                允许修改
              </button>
            )}
            <button
              type="button"
              disabled={!forkAvailable || busy}
              onClick={onFork}
              title={
                forkAvailable
                  ? "从当前对话摘要新建一个分叉聊天"
                  : "会话建立后才能分叉"
              }
              className="rounded-md px-2 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ＋ 新建
            </button>
            {onOpenHistory && (
              <button
                type="button"
                disabled={!forkAvailable}
                onClick={onOpenHistory}
                title="打开完整历史回放"
                className="rounded-md px-2 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40"
              >
                历史
              </button>
            )}
          </div>
        </div>
      </header>

      {attention === "confirm" && (
        <div className="shrink-0 border-b border-hairline bg-inset px-5 py-2.5">
          <div className="mx-auto w-full max-w-4xl">
            <div className="text-xs text-warn-text">
              Agent 正在等待你的确认
              {confirmDetail
                ? `：${confirmDetail}`
                : "（终端里有待处理的批准、登录或菜单选择）"}
            </div>
            {extraHint && (
              <div className="mt-1 text-micro text-l4">{extraHint}</div>
            )}
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onApprovalKey?.("y")}
                title="往终端按 y（各 CLI 的批准热键）"
                className="rounded-md bg-ok px-2.5 py-1 text-xs text-ok-text hover:opacity-85"
              >
                ✓ 批准
              </button>
              <button
                type="button"
                onClick={() => onApprovalKey?.("n")}
                title="往终端按 n（各 CLI 的拒绝热键）"
                className="rounded-md bg-err px-2.5 py-1 text-xs text-err-text hover:opacity-85"
              >
                ✗ 拒绝
              </button>
              <button
                type="button"
                onClick={() => onApprovalKey?.("esc")}
                title="往终端按 Esc（取消当前提示）"
                className="rounded-md px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
              >
                Esc 取消
              </button>
              <span className="mx-1 h-3.5 w-px bg-hairline" />
              <button
                type="button"
                onClick={onOpenTerminal}
                title="选项更多或按键无效时，去终端里直接操作"
                className="rounded-md px-2.5 py-1 text-xs text-l2 hover:bg-hover"
              >
                打开终端
              </button>
              {onTogglePeek && !peek && (
                <button
                  type="button"
                  onClick={onTogglePeek}
                  className="rounded-md px-2.5 py-1 text-xs text-l2 hover:bg-hover"
                >
                  露出终端
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 56;
          followRef.current = nearBottom;
          if (nearBottom) setHasNew(false);
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 pb-6 pt-8 sm:px-5">
          {hasOlder && onLoadOlder && messages.length > 0 && (
            <div className="mb-4 flex justify-center">
              <button
                type="button"
                disabled={loadingOlder}
                onClick={() => {
                  followRef.current = false;
                  loadingOlderRef.current = true;
                  prevScrollHeightRef.current =
                    scrollRef.current?.scrollHeight ?? 0;
                  onLoadOlder();
                }}
                className="rounded-md px-2.5 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40"
              >
                {loadingOlder ? "加载中…" : "加载更早的消息"}
              </button>
            </div>
          )}
          {state === "idle" && messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
              {stuckWaiting ? (
                <>
                  <p className="max-w-md text-sm text-warn-text">
                    {chatWaitText("no_session")}
                    ——信任此目录 / 登录 / 菜单选择通常在终端里
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    {onTogglePeek && (
                      <button
                        type="button"
                        onClick={onTogglePeek}
                        className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                      >
                        {peek ? "终端已露出" : "露出终端"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onOpenTerminal}
                      className="rounded-md border border-field bg-raised px-3 py-1.5 text-xs text-l2 hover:bg-inset hover:text-l1"
                    >
                      打开终端处理
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-l2">从一个问题开始</p>
              )}
            </div>
          ) : state === "detecting" && messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center pb-20 text-sm text-l4">
              正在连接当前会话…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1" />
          ) : (
            <ConversationView messages={messages} cwd={cwd} />
          )}
          {loading && (
            <div
              className="mb-2 flex items-center gap-2 text-micro text-l4"
              aria-live="polite"
            >
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="size-1.5 rounded-full bg-l4 animate-pulse" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:120ms]" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:240ms]" />
              </span>
              <span>{waitText || "已送出"}</span>
            </div>
          )}
          {hasNew && (
            <button
              type="button"
              onClick={scrollBottom}
              className="sticky bottom-2 left-1/2 mx-auto -translate-x-1/2 rounded-md border border-field bg-raised px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
            >
              有新消息 ↓
            </button>
          )}
        </div>
      </div>

      <ChatComposer
        disabled={!canSend}
        busy={busy}
        skills={skills}
        mcps={mcps}
        onSend={sendFromComposer}
        onOpenMcp={onOpenMcp}
        focusWhen={active}
        agentId={agentId}
        seedInsert={seedInsert}
        onSeedConsumed={() => setSeedInsert(null)}
        placeholder={
          readOnly ? "这是只读分叉；可以提问、分析和规划…" : undefined
        }
      />
      {peek && (
        <button
          type="button"
          onClick={onTogglePeek}
          title="收起露出的终端画面"
          className="shrink-0 border-t border-hairline bg-inset px-3 py-1 text-center text-micro text-l4 hover:bg-hover hover:text-l2"
        >
          下方是同一会话的终端 · 点此收起
        </button>
      )}
    </div>
  );
}
