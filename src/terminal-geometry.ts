/**
 * 终端启动前的布局决策，以及进程起来之后谁可以改行列。
 * 像素差不换算成行数：spawn 只用布局提交之后 fit 到的格子。
 */

export type PromptInjectMode = "positional" | "flag" | "unsupported" | "none";

/**
 * 测量前要不要改启动栏。resume 永远不改（意见不在高级栏）。
 * unsupported + 非 resume + prompt 非空：保持调用方当前的展开态。
 * 其余非 resume 且 prompt 非空：收起栏并关掉高级选项。
 * prompt 为空、或 mode 为 none（shell / 回落 shell / 自定义 Runtime）：不改。
 */
export function launchChromeBeforeMeasure(input: {
  resume: boolean;
  prompt: string;
  promptInject: PromptInjectMode;
}): { kind: "keep" } | { kind: "collapse" } {
  if (input.resume || !input.prompt.trim()) return { kind: "keep" };
  if (input.promptInject === "none" || input.promptInject === "unsupported") {
    return { kind: "keep" };
  }
  return { kind: "collapse" };
}

/** null = 没量到。任何会重放画面的 spawn 都不许把 null 交给 pty_spawn。 */
export function allowSpawn(
  size: { cols: number; rows: number } | null,
): size is { cols: number; rows: number } {
  return size != null;
}

export type ResizeLatch =
  | { kind: "unset" }
  | { kind: "frozen" }
  | { kind: "measured"; cols: number; rows: number };

/**
 * unset：还没有这次 spawn。本标签没有活 PTY 才允许。
 * frozen：这次接上的是已经在跑的进程。一律 false。
 * measured：新进程 openpty 的尺寸。任何差距都是 false，包括差两行以上。
 * attach 与防抖 onResize 都走这里，所以它们在进程活着之后不调用 pty_resize。
 * 用户改窗口、分屏、字号、侧栏、阅读区、底部状态栏时，由那些处理函数自己发一次。
 */
export function allowPtyResize(
  latch: ResizeLatch,
  _next: { cols: number; rows: number },
  livePty: boolean,
): boolean {
  if (latch.kind === "unset") return !livePty;
  return false;
}
