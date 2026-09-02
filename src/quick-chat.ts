/** 「快速开聊」随手聊历史纯逻辑（tests/quick-chat.test.ts）。
 *  只排除「点了也没法恢复」的——归档 / Ccode 内部无头会话 / 源文件已不在的 /
 *  进程仍活着的（live，resume 同会话会被 CLI 拒：active writer 冲突）。 */
import type { SessionMetaDto } from "./types";
import { pathKey } from "./path-utils.ts";

/** 「没法恢复」的会话统一排除口径 */
function recoverable(s: SessionMetaDto): boolean {
  return !s.archived && !s.internal && !s.live && s.alive;
}

/** 默认随手聊目录：家目录下 `ccode/scratch`（与 ensure_scratch_dir 同口径）。
 *  未添加到项目的编码仓库（例如 Ccode 源码目录）不算随手聊。 */
export function isScratchCwd(path: string, isWindows = false): boolean {
  const k = pathKey(path, isWindows);
  return k.endsWith("/ccode/scratch") || k.includes("/ccode/scratch/");
}

/** 侧栏「快速开聊」是否直达终端：记住过选择且没有勾「每次都先问我」。
 *  ⌘K / 工作台页头永远开弹层，不走这条。 */
export function sidebarLaunchesDirect(opts: {
  hasRemembered: boolean;
  alwaysAsk: boolean;
}): boolean {
  return opts.hasRemembered && !opts.alwaysAsk;
}

/** 快速开聊（随手聊）历史：只列 `~/ccode/scratch` 里可恢复的会话。
 *  工作区 / 已注册项目 / 别的未注册仓库都走对话页，不进这张卡。
 *  「转为项目」后 scratch 若被登记，也会被 projectPaths 挡掉。 */
export function pickQuickChatSessions(
  sessions: SessionMetaDto[],
  projectPaths: string[],
  limit = 8,
  isWindows = false,
): SessionMetaDto[] {
  // 注册项目路径来自后端注册表、会话 projectPath 来自 CLI 写的 cwd —— 两种来源在
  // Windows 上可能是 verbatim/普通、大小写、分隔符三重不同。只去尾斜杠比不中。
  // isWindows 显式传入而非在此读 IS_WINDOWS：本模块是纯逻辑层，
  // 隐式依赖平台会让单测随宿主机器变化。
  const projects = new Set(projectPaths.map((p) => pathKey(p, isWindows)));
  return sessions
    .filter(
      (s) =>
        recoverable(s) &&
        s.workspace === null &&
        isScratchCwd(s.projectPath, isWindows) &&
        !projects.has(pathKey(s.projectPath, isWindows)),
    )
    .slice(0, limit);
}

/** 终端页正在跑的会话键，与 store.sessionRuntimeKey 同形（agent + 换行 + sessionId） */
function liveSessionKey(agent: string, sessionId: string): string {
  return `${agent}\n${sessionId}`;
}

/** 用终端页 liveSessions 补标正在跑的会话（比上次 list_sessions 更新） */
export function withLiveSessionFlags(
  sessions: readonly SessionMetaDto[],
  liveSessions: Record<string, string>,
): SessionMetaDto[] {
  return sessions.map((s) => {
    const live = s.live || liveSessionKey(s.agent, s.sessionId) in liveSessions;
    return live === s.live ? s : { ...s, live };
  });
}

/** 弹层 / 右键菜单共用：本机会话列表现算随手聊历史，不 round-trip */
export function pickQuickChatHistory(
  sessions: SessionMetaDto[],
  projectPaths: string[],
  liveSessions: Record<string, string>,
  isWindows = false,
  limit = 8,
): SessionMetaDto[] {
  return pickQuickChatSessions(
    withLiveSessionFlags(sessions, liveSessions),
    projectPaths,
    limit,
    isWindows,
  );
}

/** 列表行的归属标注：工作区会话显工作区名，否则显目录尾段 */
export function sessionHomeLabel(s: SessionMetaDto): string {
  if (s.workspace) return `⛁ ${s.workspace}`;
  const parts = s.projectPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || s.projectPath;
}

/** 列表行标题：自定义标题 > 会话标题 > 摘要 > 兜底。
 *  会话标题来自后端解析器（首条实质 user 消息；纯问候语已在 usable_title 层跳过） */
export function sessionDisplayTitle(s: SessionMetaDto): string {
  return s.customTitle ?? s.title ?? s.summary ?? "未命名对话";
}
