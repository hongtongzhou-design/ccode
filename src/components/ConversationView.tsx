import { useLayoutEffect, useRef, useState } from "react";
import type { BlockDto, ChatMessageDto } from "../types";
import { FoldMark } from "./PageFrame";
import ChatMarkdown, { ChatImageCard } from "./ChatMarkdown";
import { fmtTokens } from "./TerminalStatusBar";
import { splitImagePaths } from "../chat-image";

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

/** 在命中消息里标出第一个关键词并返回该节点，供滚进视野。失败则返回 null。 */
function markFirstKeyword(root: Element, keywords: string[]): HTMLElement | null {
  const terms = keywords
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 2);
  if (terms.length === 0) return null;
  const existing = root.querySelector("[data-search-mark='1']");
  if (existing instanceof HTMLElement) return existing;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    const hit = terms.find((t) => lower.includes(t));
    if (!hit) continue;
    const idx = lower.indexOf(hit);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, Math.min(text.length, idx + hit.length));
    const mark = document.createElement("mark");
    mark.dataset.searchMark = "1";
    mark.className = "rounded-sm bg-warn/40";
    try {
      range.surroundContents(mark);
      return mark;
    } catch {
      return node.parentElement;
    }
  }
  return null;
}

/**
 * 结构化对话渲染（用户右对齐气泡 / AI 直接排版 / 围栏代码块 / 工具调用折叠行 / 长文本截断）。
 * 会话页回放与终端侧栏共用；滚动容器由调用方提供。
 */
export default function ConversationView({
  messages,
  compact,
  cwd,
  focusIndex = -1,
  focusKeywords,
}: {
  messages: ChatMessageDto[];
  compact?: boolean;
  /** 会话工作目录：AI 正文里相对图片/链接的解析基准（ChatMarkdown 用） */
  cwd?: string | null;
  /** 搜索命中的消息下标；≥0 时高亮并滚进视野 */
  focusIndex?: number;
  /** 搜索关键词，用来在命中消息里标出那一句 */
  focusKeywords?: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hitRef = useRef<HTMLDivElement | null>(null);
  const didFocusScroll = useRef(false);

  useLayoutEffect(() => {
    if (focusIndex < 0 || didFocusScroll.current) return;
    const el = hitRef.current;
    if (!el) return;
    const marked = markFirstKeyword(el, focusKeywords ?? []);
    (marked ?? el).scrollIntoView({ block: "center" });
    didFocusScroll.current = true;
  }, [focusIndex, focusKeywords]);

  /** 消息稳定键：角色+时间戳+块数+首段文本特征。前插分页/轮询刷新后数组下标会移位，
   *  展开状态（思考过程/工具调用/长文本）必须跟随内容而非位置 */
  function msgKey(m: ChatMessageDto, mi: number): string {
    const firstText = m.blocks.find((b) => b.kind === "text")?.text ?? "";
    return `${m.role}:${m.timestamp ?? `#${mi}`}:${m.blocks.length}:${firstText.length}:${firstText.slice(0, 24)}`;
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 长文本截断渲染，key 用于记录展开状态；短文本/已展开走围栏代码拆分 */
  function richText(key: string, text: string, cls: string, forceOpen = false) {
    const isOpen = forceOpen || expanded.has(key);
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

  function renderBlock(b: BlockDto, key: string, isUser: boolean, forceOpen = false) {
    if (b.kind === "thinking") {
      const isOpen = expanded.has(key);
      return (
        <div key={key} className="my-1">
          <button
            onClick={() => toggleExpand(key)}
            className="text-xs text-l4 hover:text-l2"
          >
            <span className="inline-flex items-center gap-1">
              <FoldMark open={isOpen} /> 思考过程
            </span>
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
          className="my-1 inline-block max-w-full rounded-sm border border-hairline bg-inset px-2 py-1 font-mono text-xs text-l3"
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
    // text（用户消息同样截断：超大粘贴不全量渲染）；
    // 整行是图片路径的行剥离成内嵌图片卡（粘贴/拖拽图片在会话里就是一行路径文本）
    const { text: bodyText, images } = splitImagePaths(b.text);
    const imageRow = images.map((p) => (
      <ChatImageCard key={p} path={p} cwd={cwd} />
    ));
    if (isUser) {
      return (
        <div key={key} className="my-1">
          {bodyText && richText(key, bodyText, "whitespace-pre-wrap", forceOpen)}
          {imageRow}
        </div>
      );
    }
    // AI 正文走 Markdown 渲染（ChatMarkdown：原始 HTML 转义 + 本地图片内嵌）；
    // 超长未展开保持截断纯文本 + 展开按钮，展开后整段 Markdown
    if (bodyText.length > TEXT_CAP && !forceOpen && !expanded.has(key)) {
      return (
        <div key={key} className="my-1">
          {richText(key, bodyText, `whitespace-pre-wrap ${compact ? "text-xs" : "text-sm"}`)}
          {imageRow}
        </div>
      );
    }
    return (
      <div key={key} className="my-1">
        {bodyText && <ChatMarkdown text={bodyText} cwd={cwd} />}
        {imageRow}
        {bodyText.length > TEXT_CAP && (
          <button
            onClick={() => toggleExpand(key)}
            className="text-xs text-l3 hover:text-l1"
          >
            收起
          </button>
        )}
      </div>
    );
  }

  /** 连续 tool_use / tool_result 归并为一组（按消息内顺序），其余块保持原位 */
  function runsOf(blocks: BlockDto[], mkey: string): Run[] {
    const runs: Run[] = [];
    blocks.forEach((b, bi) => {
      const isTool = b.kind === "tool_use" || b.kind === "tool_result";
      const last = runs[runs.length - 1];
      if (isTool && last && last.tool) {
        last.blocks.push(b);
      } else if (isTool) {
        runs.push({ tool: true, blocks: [b], key: `${mkey}:t${bi}` });
      } else {
        runs.push({ tool: false, block: b, key: `${mkey}:${bi}` });
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
    // 计数只算 tool_use：tool_result 与调用并入同一条消息（如 codex 解析），
    // 直接数块数会把一次调用显示成两次
    const callCount =
      run.blocks.filter((b) => b.kind === "tool_use").length ||
      run.blocks.length;
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
          className="flex h-7 w-full items-center gap-1.5 rounded-md bg-inset/65 px-2 text-xs text-l3 hover:bg-raised hover:text-l1"
        >
          <FoldMark open={isOpen} />
          <span className="shrink-0">{callCount} 次工具调用</span>
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

  function renderRuns(m: ChatMessageDto, mkey: string, isUser: boolean, forceOpen = false) {
    return runsOf(m.blocks, mkey).map((run) =>
      run.tool
        ? renderToolRun(run, isUser)
        : renderBlock(run.block, run.key, isUser, forceOpen),
    );
  }

  return (
    <>
      {messages.map((m, mi) => {
        const mk = msgKey(m, mi);
        const hit = mi === focusIndex;
        return m.role === "user" ? (
          // 用户消息：右对齐圆角气泡（bubble 令牌底，max-w 70%）
          <div
            key={mk}
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            className="mb-3 flex justify-end"
          >
            <div
              className={`max-w-[70%] rounded-md bg-bubble/75 px-3 py-2 ${compact ? "text-xs" : "text-sm"} ${
                hit ? "ring-1 ring-cta-bd" : ""
              }`}
            >
              {renderRuns(m, mk, true, hit)}
            </div>
          </div>
        ) : (
          // AI 回复：直接排版，无气泡容器；有逐条 usage 的 agent 在消息末尾标 token
          <div
            key={mk}
            ref={hit ? hitRef : undefined}
            data-search-hit={hit ? "1" : undefined}
            className={`mb-3 max-w-full ${hit ? "rounded-md bg-seg-sel px-2 py-1" : ""}`}
          >
            {renderRuns(m, mk, false, hit)}
            {m.usage && (m.usage.input > 0 || m.usage.output > 0) && (
              <div
                className="mt-0.5 text-micro text-l4"
                title="本条消息的 token 用量（输入↑ 输出↓）"
              >
                {fmtTokens(m.usage.input)}↑ {fmtTokens(m.usage.output)}↓
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
