import { useEffect, useRef, useState } from "react";
import ConversationView from "./ConversationView";
import ChatComposer from "./ChatComposer";
import type {
  ChatMessageDto,
  McpServerDto,
  SessionSyncState,
  SkillDto,
} from "../types";

export default function ChatSurface({
  messages,
  state,
  syncState,
  title,
  loading,
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
}: {
  messages: ChatMessageDto[];
  state: "idle" | "detecting" | "linked" | "timeout";
  syncState: SessionSyncState;
  title: string | null;
  loading: boolean;
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
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [hasNew, setHasNew] = useState(false);

  function scrollBottom() {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = true;
    setHasNew(false);
    el.scrollTop = el.scrollHeight;
  }

  useEffect(() => {
    if (followRef.current) requestAnimationFrame(scrollBottom);
    else setHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

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
  const statusClass = attention === "confirm"
    ? "bg-warn-text"
    : running
      ? "bg-ok-text animate-pulse-brief"
      : "bg-l4";
  const shortCwd = cwd ? cwd.replace(/^.*[\\/]/, "") : null;

  return (
    <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-canvas">
      <header className="shrink-0 border-b border-hairline bg-canvas/95 px-5 py-3 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3">
          <span className={`size-2 shrink-0 rounded-full ${statusClass}`} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-medium text-l1">{title || "当前聊天"}</h1>
              <span className="shrink-0 text-micro text-l4">{statusText()}</span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-micro text-l4">
              {agentName && <span>{agentName}</span>}
              {model && <><span>·</span><span>{model}</span></>}
              {shortCwd && <><span>·</span><span className="truncate">{shortCwd}</span></>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="hidden text-micro text-l4 sm:inline">{skills.length} 技能 · {mcps.length} MCP</span>
            {readOnly && (
              <span
                className="rounded-md bg-inset px-2 py-1 text-micro text-warn-text"
                title={readonlySupported ? "该分叉会话启用了 Agent 原生只读/计划模式" : "该 Agent 没有原生只读参数，仅提供提示约束"}
              >
                只读分叉
              </span>
            )}
            {readOnly && (
              <button type="button" onClick={onAllowWrite} className="rounded-md px-2 py-1 text-micro text-warn-text hover:bg-hover">
                允许修改
              </button>
            )}
            <button
              type="button"
              disabled={!forkAvailable || busy}
              onClick={onFork}
              title={forkAvailable ? "从当前对话摘要新建一个分叉聊天" : "会话建立后才能分叉"}
              className="rounded-md px-2 py-1 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              ＋ 新建聊天
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
        <div className="shrink-0 bg-inset px-5 py-2">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 text-xs text-warn-text">
            <span>Agent 需要终端确认、登录或菜单选择。</span>
            <button type="button" onClick={onOpenTerminal} className="shrink-0 rounded-md px-2 py-1 text-l2 hover:bg-hover">
              打开终端
            </button>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
          followRef.current = nearBottom;
          if (nearBottom) setHasNew(false);
        }}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-5 pb-8 pt-10">
          {state === "idle" && messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
              <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-raised text-lg text-l3">✦</div>
              <p className="text-sm text-l2">从一个问题开始</p>
              <p className="mt-1 text-xs text-l4">聊天和终端共享同一个会话上下文</p>
            </div>
          ) : state === "detecting" && messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center pb-20 text-sm text-l4">正在连接当前会话…</div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center pb-20 text-sm text-l4">等待第一条对话…</div>
          ) : (
            <ConversationView messages={messages} />
          )}
          {loading && (
            <div className="mb-3 flex items-center gap-2 text-xs text-l4" aria-live="polite">
              <span className="flex items-center gap-1" aria-hidden="true">
                <span className="size-1.5 rounded-full bg-l4 animate-pulse" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:120ms]" />
                <span className="size-1.5 rounded-full bg-l4 animate-pulse [animation-delay:240ms]" />
              </span>
              <span>Agent 正在处理…</span>
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
        onSend={onSend}
        onOpenMcp={onOpenMcp}
        placeholder={readOnly ? "这是只读分叉；可以提问、分析和规划…" : undefined}
      />
    </div>
  );
}
