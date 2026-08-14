import { useState } from "react";
import type { BlockDto, ChatMessageDto } from "../types";

/** 文本块超过该长度先截断，点「展开全部」再看完整内容 */
const TEXT_CAP = 4000;

/** 围栏代码段拆分结果：普通文本段与代码段交替 */
type TextPart =
  | { code: false; text: string }
  | { code: true; lang: string; text: string };

/** 按 ``` 围栏拆分文本；奇数个围栏时末段按未闭合代码块处理（会话尾部截断常见） */
function splitFenced(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const segments = text.split("```");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i % 2 === 0) {
      if (seg) parts.push({ code: false, text: seg });
      continue;
    }
    // 代码段首行可能是语言标记；不像语言标记（含空白/超长）则整段按代码处理
    const nl = seg.indexOf("\n");
    const head = nl === -1 ? seg.trim() : seg.slice(0, nl).trim();
    const valid = /^[\w#+.-]{1,20}$/.test(head);
    parts.push({
      code: true,
      lang: valid ? head : "",
      text: valid ? (nl === -1 ? "" : seg.slice(nl + 1)) : seg,
    });
  }
  return parts;
}

/** 代码块：inset 底 + hairline 细边，头部语言名 + hover/focus 显现的 ⧉ 复制 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code my-1.5 overflow-hidden rounded-md border border-hairline bg-inset">
      <div className="flex h-6 items-center justify-between border-b border-hairline px-2.5">
        <span className="text-micro text-l4">{lang || "code"}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(text)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
          className="text-micro text-l3 opacity-0 transition-opacity hover:text-l1 focus-visible:opacity-100 group-hover/code:opacity-100"
        >
          {copied ? "已复制" : "⧉ 复制"}
        </button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-xs leading-relaxed text-l2">
        <code>{text.replace(/\n+$/, "")}</code>
      </pre>
    </div>
  );
}

/** 一条消息内的渲染单元：普通块单发；连续 tool_use/tool_result 归并成一个折叠组 */
type Run =
  | { tool: false; block: BlockDto; key: string }
  | { tool: true; blocks: BlockDto[]; key: string };

/**
 * 结构化对话渲染（用户右对齐气泡 / AI 直接排版 / 围栏代码块 / 工具调用折叠行 / 长文本截断）。
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

  /** 长文本截断渲染，key 用于记录展开状态；短文本/已展开走围栏代码拆分 */
  function richText(key: string, text: string, cls: string) {
    const isOpen = expanded.has(key);
    if (text.length > TEXT_CAP && !isOpen) {
      return (
        <div className={cls}>
          {`${text.slice(0, TEXT_CAP)}…`}
          <button
            onClick={() => toggleExpand(key)}
            className="ml-2 text-l3 hover:text-l1"
          >
            展开全部
          </button>
        </div>
      );
    }
    const parts = splitFenced(text);
    // 无代码围栏时保持纯文本渲染（绝大多数消息走这里）
    if (parts.every((p) => !p.code)) {
      return (
        <div className={cls}>
          {text}
          {text.length > TEXT_CAP && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-2 text-l3 hover:text-l1"
            >
              收起
            </button>
          )}
        </div>
      );
    }
    return (
      <div className={cls}>
        {parts.map((p, i) =>
          p.code ? (
            <CodeBlock key={i} lang={p.lang} text={p.text} />
          ) : (
            // 代码块前后的换行只是围栏分隔，去掉避免多出空行
            <span key={i}>{p.text.replace(/^\n+|\n+$/g, "")}</span>
          ),
        )}
        {text.length > TEXT_CAP && (
          <button
            onClick={() => toggleExpand(key)}
            className="ml-2 text-l3 hover:text-l1"
          >
            收起
          </button>
        )}
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
            className="text-xs text-l4 hover:text-l2"
          >
            {isOpen ? "▾" : "▸"} 思考过程
          </button>
          {isOpen && (
            <div className="mt-1 whitespace-pre-wrap rounded-sm bg-inset p-2 text-xs italic text-l3">
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
          className="my-1 inline-block max-w-full rounded-sm bg-inset px-2 py-1 font-mono text-xs text-l3"
        >
          <span className="mr-1 rounded-sm bg-seg-sel px-1 text-l2">{b.toolName ?? "tool"}</span>
          <span className="whitespace-pre-wrap break-all">
            {isOpen || !long ? b.text : `${b.text.slice(0, 120)}…`}
          </span>
          {long && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-1 text-l3 hover:text-l1"
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
          className="my-1 whitespace-pre-wrap break-all rounded-sm border border-hairline bg-inset p-2 font-mono text-xs text-l3"
        >
          {isOpen || !long ? b.text : `${b.text.slice(0, 200)}…`}
          {long && (
            <button
              onClick={() => toggleExpand(key)}
              className="ml-1 text-l3 hover:text-l1"
            >
              {isOpen ? "收起" : "展开"}
            </button>
          )}
        </div>
      );
    }
    // text（用户消息同样截断：超大粘贴不全量渲染）
    if (isUser) {
      return (
        <div key={key} className="my-1">
          {richText(key, b.text, "whitespace-pre-wrap")}
        </div>
      );
    }
    return (
      <div key={key} className="my-1">
        {richText(key, b.text, `whitespace-pre-wrap ${compact ? "text-xs" : "text-sm"}`)}
      </div>
    );
  }

  /** 连续 tool_use / tool_result 归并为一组（按消息内顺序），其余块保持原位 */
  function runsOf(blocks: BlockDto[], mi: number): Run[] {
    const runs: Run[] = [];
    blocks.forEach((b, bi) => {
      const isTool = b.kind === "tool_use" || b.kind === "tool_result";
      const last = runs[runs.length - 1];
      if (isTool && last && last.tool) {
        last.blocks.push(b);
      } else if (isTool) {
        runs.push({ tool: true, blocks: [b], key: `${mi}:t${bi}` });
      } else {
        runs.push({ tool: false, block: b, key: `${mi}:${bi}` });
      }
    });
    return runs;
  }

  /** 工具调用折叠行：「▸ N 次工具调用」，展开后保留原有逐块渲染 */
  function renderToolRun(
    run: Extract<Run, { tool: true }>,
    isUser: boolean,
  ) {
    const isOpen = expanded.has(run.key);
    const names = [
      ...new Set(
        run.blocks
          .map((b) => b.toolName)
          .filter((n): n is string => n !== null),
      ),
    ];
    return (
      <div key={run.key} className="my-1">
        <button
          type="button"
          onClick={() => toggleExpand(run.key)}
          aria-expanded={isOpen}
          className="flex h-7 w-full items-center gap-1.5 rounded-md bg-inset px-2 text-left text-xs text-l3 hover:bg-raised hover:text-l1"
        >
          <span className="shrink-0 text-micro text-l4">
            {isOpen ? "▾" : "▸"}
          </span>
          <span className="shrink-0">{run.blocks.length} 次工具调用</span>
          {names.length > 0 && (
            <span className="min-w-0 truncate text-l4">
              {names.slice(0, 3).join("、")}
              {names.length > 3 ? ` 等 ${names.length} 种` : ""}
            </span>
          )}
        </button>
        {isOpen && (
          <div className="mt-1">
            {run.blocks.map((b, bi) =>
              renderBlock(b, `${run.key}:${bi}`, isUser),
            )}
          </div>
        )}
      </div>
    );
  }

  function renderRuns(m: ChatMessageDto, mi: number, isUser: boolean) {
    return runsOf(m.blocks, mi).map((run) =>
      run.tool
        ? renderToolRun(run, isUser)
        : renderBlock(run.block, run.key, isUser),
    );
  }

  return (
    <>
      {messages.map((m, mi) =>
        m.role === "user" ? (
          // 用户消息：右对齐圆角气泡（bubble 令牌底，max-w 70%）
          <div key={mi} className="mb-3 flex justify-end">
            <div
              className={`max-w-[70%] rounded-lg bg-bubble px-3 py-2 ${compact ? "text-xs" : "text-sm"}`}
            >
              {renderRuns(m, mi, true)}
            </div>
          </div>
        ) : (
          // AI 回复：直接排版，无气泡容器
          <div key={mi} className="mb-3 max-w-full">
            {renderRuns(m, mi, false)}
          </div>
        ),
      )}
    </>
  );
}
