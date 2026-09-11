/**
 * 对话回放：连续工具调用聚合成一条执行记录。
 * 同一条消息内的归并仍由 ConversationView.runsOf 做；这里管跨消息。
 */
import type { BlockDto, ChatMessageDto } from "./types.ts";

const ALERT_RE =
  /permission denied|ask.?user|needs? approval|not authorized|interrupted|EACCES|中断|拒绝|待确认|需要你确认/i;

export function isToolBlock(block: BlockDto): boolean {
  return block.kind === "tool_use" || block.kind === "tool_result";
}

/** 助手消息里只有工具调用/结果，没有正文或思考。 */
export function isToolOnlyAssistant(message: ChatMessageDto): boolean {
  if (message.role === "user") return false;
  if (message.blocks.length === 0) return false;
  return message.blocks.every(isToolBlock);
}

/** 失败、权限确认、中断单独露出，不并进折叠执行记录。 */
export function isAlertToolMessage(message: ChatMessageDto): boolean {
  return message.blocks.some((block) => {
    if (block.kind === "tool_result" || block.kind === "text") {
      return ALERT_RE.test(block.text);
    }
    return false;
  });
}

export type ConversationSegment =
  | { kind: "message"; message: ChatMessageDto; index: number }
  | {
      kind: "tool-run";
      messages: ChatMessageDto[];
      startIndex: number;
      blocks: BlockDto[];
    };

export function groupConversationSegments(
  messages: readonly ChatMessageDto[],
): ConversationSegment[] {
  const out: ConversationSegment[] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i]!;
    if (isToolOnlyAssistant(current) && !isAlertToolMessage(current)) {
      const startIndex = i;
      const group: ChatMessageDto[] = [];
      while (i < messages.length) {
        const next = messages[i]!;
        if (!isToolOnlyAssistant(next) || isAlertToolMessage(next)) break;
        group.push(next);
        i += 1;
      }
      out.push({
        kind: "tool-run",
        messages: group,
        startIndex,
        blocks: group.flatMap((item) => item.blocks),
      });
      continue;
    }
    out.push({ kind: "message", message: current, index: i });
    i += 1;
  }
  return out;
}

export function segmentContainsIndex(
  segment: ConversationSegment,
  index: number,
): boolean {
  if (segment.kind === "message") return segment.index === index;
  return (
    index >= segment.startIndex &&
    index < segment.startIndex + segment.messages.length
  );
}

export function toolCallCount(blocks: readonly BlockDto[]): number {
  const uses = blocks.filter((block) => block.kind === "tool_use").length;
  return uses || blocks.length;
}

export function isProcessBlock(block: BlockDto): boolean {
  return block.kind === "thinking" || isToolBlock(block);
}

/** 预览里思考+工具收成一条折叠行的标题。 */
export function processFoldLabel(blocks: readonly BlockDto[]): string {
  const thinking = blocks.some((block) => block.kind === "thinking");
  const tools = blocks.filter(isToolBlock);
  const calls = tools.length === 0 ? 0 : toolCallCount(tools);
  if (thinking && calls > 0) return `过程 · 思考与 ${calls} 次工具调用`;
  if (thinking) return "思考过程";
  return `执行记录 · ${calls} 次工具调用`;
}
