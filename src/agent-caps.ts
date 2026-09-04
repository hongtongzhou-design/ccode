/**
 * 能力表前端消费：只读 / 无头写盘的置灰与人话。
 * 数据来自 agent_capabilities，不在前端另抄名单。
 */

export interface HeadlessWriteFlag {
  supported: boolean;
  reason?: string;
}

/** 定时任务禁选：不支持写盘（如 qwen 未验证）。 */
export function headlessWriteBlocked(
  cap: HeadlessWriteFlag | undefined,
): string | null {
  if (!cap || cap.supported) return null;
  return cap.reason?.trim() || "不能用于定时任务";
}

/** 支持但要标出来的附注（如 grok 无沙箱）。 */
export function headlessWriteNote(
  cap: HeadlessWriteFlag | undefined,
): string | null {
  if (!cap?.supported) return null;
  return cap.reason?.trim() || null;
}
