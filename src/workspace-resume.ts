/** 工作区「去终端」的 resume 挑选纯逻辑（tests/workspace-resume.test.ts）。
 *  背景：worktree 会话在列表扫描时已归并回真实仓库（projectPath 改写为仓库路径、
 *  workspace 记工作区名），所以按 workspace 名 + 仓库路径两者匹配。 */
import type { SessionMetaDto } from "./types";

/** 从会话列表（已按最近活跃降序）挑出该工作区可 resume 的最近一条；无命中返回 null。
 *  排除归档（恢复语义怪异）、Ccode 内部无头会话（不是人聊的对话）、
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
