/** 「快速开聊」随手聊历史纯逻辑（tests/quick-chat.test.ts）。
 *  只排除「点了也没法恢复」的——归档 / Ccode 内部无头会话 / 源文件已不在的 /
 *  进程仍活着的（live，resume 同会话会被 CLI 拒：active writer 冲突）。 */
import type { SessionMetaDto } from "./types";

/** 「没法恢复」的会话统一排除口径 */
function recoverable(s: SessionMetaDto): boolean {
  return !s.archived && !s.internal && !s.live && s.alive;
}

/** 快速开聊（随手聊）历史口径：不落在任何工作区、也不落在任何已注册项目里的会话
 *  （快速开聊承诺不建项目不写 .ccode；落在项目/工作区里的对话自有其入口，不算随手聊）。
 *  注意「转为项目」后 cwd 变成注册项目，该会话随之改归项目、不再出现在这里——预期行为。 */
export function pickQuickChatSessions(
  sessions: SessionMetaDto[],
  projectPaths: string[],
  limit = 8,
): SessionMetaDto[] {
  const norm = (p: string) => p.replace(/[\\/]+$/, "");
  const projects = projectPaths.map(norm);
  return sessions
    .filter(
      (s) =>
        recoverable(s) &&
        s.workspace === null &&
        !projects.includes(norm(s.projectPath)),
    )
    .slice(0, limit);
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
  return s.customTitle ?? s.title ?? s.summary ?? "（无标题）";
}
