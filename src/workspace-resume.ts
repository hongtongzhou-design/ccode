/** 工作区「去终端」的 resume 挑选纯逻辑（tests/workspace-resume.test.ts）。
 *  背景：worktree 会话在列表扫描时已归并回真实仓库（projectPath 改写为仓库路径、
 *  workspace 记工作区名），所以按 workspace 名 + 仓库路径两者匹配。 */
import type { SessionMetaDto } from "./types";

/** 工作区交接要不要接回最近会话。
 *  无首条指令（去终端看看）→ 接回；开工/按意见重写有指令 → 新开会话；
 *  评审「退回修改」显式 resumeSession → 接回并把意见当下一轮输入。 */
export function shouldResumeWorkspaceSession(opts?: {
  hasPrompt?: boolean;
  resumeSession?: boolean;
}): boolean {
  if (opts?.resumeSession) return true;
  return !opts?.hasPrompt;
}

/** 从会话列表（已按最近活跃降序）挑出该工作区可 resume 的最近一条；无命中返回 null。
 *  排除归档（恢复语义怪异）、Mesa 内部无头会话（不是人聊的对话）、
 *  live（CLI 进程仍活着，resume 同会话会冲突） */
export function pickWorkspaceResume(
  sessions: SessionMetaDto[],
  workspaceName: string,
  repoPath: string,
): { agentId: string; sessionId: string } | null {
  const repo = repoPath.replace(/[\\/]+$/, "");
  const hit = sessions.find(
    (s) =>
      s.workspace === workspaceName &&
      s.projectPath.replace(/[\\/]+$/, "") === repo &&
      !s.archived &&
      !s.internal &&
      !s.live,
  );
  return hit ? { agentId: hit.agent, sessionId: hit.sessionId } : null;
}
