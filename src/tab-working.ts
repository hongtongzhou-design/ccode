/** 终端标签「生成中」虚线圆：只表示这一轮正在出字，不是进程还活着。 */

export type TabAttention = "done" | "working" | "confirm" | null;

/** 敲键/焦点引起的 TUI 重绘不算生成中 */
export const PTY_ECHO_SUPPRESS_MS = 300;
/** 已经出过字之后，PTY 静默这么久视为本轮生成结束 */
export const PTY_WORKING_SILENCE_MS = 2000;

export function ptyInputLooksLikeSubmit(data: string, kimiEnter: string): boolean {
  return data.includes("\r") || data.includes("\n") || data.includes(kimiEnter);
}

/** 启动/恢复本身不算生成中。只有这次启动会注入首条指令才点亮。恢复会话后端不注入。 */
export function shouldArmWorkingOnLaunch(input: {
  prompt?: string | null;
  isResume: boolean;
}): boolean {
  if (input.isResume) return false;
  return Boolean(input.prompt?.trim());
}

/** 会话窗口最后一条有效消息已经是助手正文（无待执行工具）= 这一轮已经生成完。 */
export function conversationTurnSettled(
  messages: { role: string; blocks: { kind: string; text: string }[] }[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const hasTool = message.blocks.some((block) => block.kind === "tool_use");
    const hasText = message.blocks.some(
      (block) => block.kind === "text" && Boolean(block.text.trim()),
    );
    if (!hasTool && !hasText) continue;
    if (message.role === "user") return false;
    if (hasTool) return false;
    return true;
  }
  return false;
}

/** PTY 输出要不要把标签打成 working。confirm 不抢；回合结束后的 TUI 残帧必须 armed。 */
export function ptyOutputMarksWorking(input: {
  prev: TabAttention;
  armed: boolean;
  msSinceInteraction: number;
}): boolean {
  if (input.msSinceInteraction <= PTY_ECHO_SUPPRESS_MS) return false;
  if (input.prev === "confirm") return false;
  if (input.prev === "working") return true;
  return input.armed;
}

/** 会话尾部 working 很黏（user 行直到 assistant 落盘），不得在 PTY 已熄灭后重新点亮转圈。
 *  会话窗口已经落完助手正文时立刻 done，不等 sticky working / PTY 静默。 */
export function applyTailAttention(input: {
  prev: TabAttention;
  tail: string;
  armed: boolean;
  turnSettled?: boolean;
}): { attention: TabAttention; armed: boolean } {
  if (input.tail === "confirm") return { attention: "confirm", armed: false };
  if (input.tail === "done" || input.turnSettled) {
    return { attention: "done", armed: false };
  }
  if (input.tail === "working") {
    if (input.armed || input.prev === "working") {
      return { attention: "working", armed: input.armed };
    }
    return { attention: input.prev, armed: false };
  }
  return { attention: null, armed: input.armed };
}

/** 生成中静默：还在等首个输出则保持；已经出过字则熄灭，防止会话文件 working 把圆点回来。
 *  启动注入的首轮（pendingReply）TUI 开屏也算出字，但不能据此熄灭——模型还在想。 */
export function onPtyWorkingSilence(input: {
  prev: TabAttention;
  armed: boolean;
  hadPtyWorkingOutput: boolean;
  pendingReply?: boolean;
}): { attention: TabAttention; armed: boolean; clearHadOutput: boolean } {
  if (input.prev !== "working") {
    return {
      attention: input.prev,
      armed: input.armed,
      clearHadOutput: false,
    };
  }
  if (input.armed && (!input.hadPtyWorkingOutput || input.pendingReply)) {
    return { attention: "working", armed: true, clearHadOutput: false };
  }
  return { attention: null, armed: false, clearHadOutput: true };
}
