/**
 * 工作区列表的聚焦步骤可见性规则（纯逻辑，供 WorkspacesPage 工作区列表过滤）。
 *
 * - 未聚焦（focusStepName = null，总览）→ 全量显示；
 * - 聚焦某步骤 → 绑定该步骤的工作区（步骤 workspaceName === 工作区名，与步进器
 *   deriveStepStatus 同一映射）+ 不匹配任何步骤 workspaceName 的工作区——
 *   用户手动建的工作区不能被默认视图藏掉（曾在按步骤过滤下对「全部」之外不可见）。
 */
export function filterWorkspacesByFocus<T extends { name: string }>(
  list: readonly T[],
  steps: readonly { name: string; workspaceName: string }[],
  focusStepName: string | null,
): T[] {
  if (!focusStepName) return [...list];
  const focusWsName = steps.find((s) => s.name === focusStepName)
    ?.workspaceName;
  const bound = new Set(
    steps.map((s) => s.workspaceName).filter((n) => n !== ""),
  );
  return list.filter((w) => w.name === focusWsName || !bound.has(w.name));
}
