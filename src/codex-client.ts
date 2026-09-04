/**
 * Codex 桌面客户端深链（ChatGPT.app 内嵌 Codex）。
 * 会话：codex://threads/<id>（对话页已用，0.151 实测）。
 * 项目：codex://threads/new?path=<绝对路径>（客户端 0.152 解析 path 查询参数，在该目录新开对话）。
 */
import { IS_MAC, IS_WINDOWS } from "./hotkeys.ts";

/** 桌面客户端只在 macOS / Windows；Linux 无客户端 */
export function canOpenCodexClient(): boolean {
  return IS_MAC || IS_WINDOWS;
}

export function codexThreadDeeplink(sessionId: string): string {
  return `codex://threads/${sessionId}`;
}

/** 在客户端以该目录为工作目录新开对话。path 必须是绝对路径。 */
export function codexNewThreadDeeplink(absPath: string): string {
  const trimmed = absPath.trim();
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", trimmed);
  return url.toString();
}
