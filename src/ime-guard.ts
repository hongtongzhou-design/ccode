//! 输入法组词期间的 Enter 不得触发发送（tests/ime-guard.test.ts）。
//!
//! WKWebView / Safari：确认候选的那次 Enter 往往在 compositionend 之后才到 keydown，
//! 此时 isComposing 已经是 false，只看 isComposing 会把上屏当成发送。
//! Chromium 组词中的 keydown 常用 keyCode 229（IME）。两道都拦。

export function imeBlocksEnter(input: {
  isComposing: boolean;
  /** KeyboardEvent.keyCode；组词中常见 229 */
  keyCode: number;
  /** compositionstart 起、到 compositionend 后一帧仍为 true */
  composingLock: boolean;
}): boolean {
  return input.isComposing || input.keyCode === 229 || input.composingLock;
}
