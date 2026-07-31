import { useState } from "react";
import type { BlockDto, ChatMessageDto } from "../types";

/** 文本块超过该长度先截断，点「展开全部」再看完整内容 */
const TEXT_CAP = 4000;

/**
 * 结构化对话渲染（气泡 / 折叠思考 / 工具块 / 长文本截断）。
 * 会话页回放与终端侧栏共用；滚动容器由调用方提供。
 */
export default function ConversationView({
  messages,
  compact,
}: {
  messages: ChatMessageDto[];
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 长文本截断渲染，key 用于记录展开状态 */
  function cappedText(key: string, text: string, cls: string) {
    const isOpen = expanded.has(key);
    if (text.length <= TEXT_CAP) return <div className={cls}>{text}</div>;
    return (
      <div className={cls}>
        {isOpen ? text : `${text.slice(0, TEXT_CAP)}…`}
        <button
          onClick={() => toggleExpand(key)}
          className="ml-2 text-blue-600 hover:underline"
        >
          {isOpen ? "收起" : "展开全部"}
        </button>
      </div>
    );
  }

  function renderBlock(b: BlockDto, key: string, isUser: boolean) {
    if (b.kind === "thinking") {
      const isOpen = expanded.has(key);
      return (
        <div key={key} className="my-1">
          <button
            onClick={() => toggleExpand(key)}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            {isOpen ? "▾" : "▸"} 思考过程
          </button>
          {isOpen && (
            <div className="mt-1 whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs italic text-neutral-500">
              {b.text}
            </div>
          )}
        </div>
      );
    }
    if (b.kind === "tool_use") {
      const isOpen = expanded.has(key);
      const long = b.text.length > 120;
      return (
        <div
          key={key}
          className="my-1 inline-block max-w-full rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600"
        >
          <span className="mr-1 rounded bg-neutral-200 px-1">{b.toolName ?? "tool"}</span>
          <span className="whitespace-pre-wrap break-all">
            {isOpen || !long ? b.text : `${b.text.slice(0, 120)}…`}
          </span>
          {long && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-1 text-blue-600 hover:underline"
            >
              {isOpen ? "收起" : "展开"}
            </button>
          )}
        </div>
      );
    }
    if (b.kind === "tool_result") {
      const isOpen = expanded.has(key);
      const long = b.text.length > 200;
      return (
        <div
          key={key}
          className="my-1 whitespace-pre-wrap break-all rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs text-neutral-500"
        >
          {isOpen || !long ? b.text : `${b.text.slice(0, 200)}…`}
          {long && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-1 text-blue-600 hover:underline"
            >
              {isOpen ? "收起" : "展开"}
            </button>
          )}
        </div>
      );
    }
    // text
    if (isUser) {
      return (
        <div key={key} className="my-1 whitespace-pre-wrap">
          {b.text}
        </div>
      );
    }
    return (
      <div key={key} className="my-1">
        {cappedText(key, b.text, `whitespace-pre-wrap ${compact ? "text-xs" : "text-sm"}`)}
      </div>
    );
  }

  return (
    <>
      {messages.map((m, mi) =>
        m.role === "user" ? (
          <div key={mi} className="mb-3 flex justify-end">
            <div
              className={`max-w-[80%] rounded-lg bg-blue-100 px-3 py-2 ${compact ? "text-xs" : "text-sm"}`}
            >
              {m.blocks.map((b, bi) => renderBlock(b, `${mi}:${bi}`, true))}
            </div>
          </div>
        ) : (
          <div key={mi} className={`mb-3 ${compact ? "max-w-full" : "max-w-[90%]"}`}>
            {m.blocks.map((b, bi) => renderBlock(b, `${mi}:${bi}`, false))}
          </div>
        ),
      )}
    </>
  );
}
