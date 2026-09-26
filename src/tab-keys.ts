/**
 * 标签栏/分段控件的键盘导航。
 *
 * 之前只有 `SegTabs`（用量页的时间范围、筛选）实现了方向键与游标 tabindex，
 * `ProjectSurfaceTabs`（项目详情的对话/任务/文件/Agents）只有一个裸 role="tablist"：
 * 方向键不动、每个按钮都 tabIndex=0（Tab 键要按五次才穿过一排标签）。
 * 两处规则本该一致，抽到这里，调用方只决定「按键后立刻切」还是「按键后等 Enter」。
 */

/** 方向键 → 位移；不是导航键则 0（水平与垂直都认，标签栏横竖排版都适用） */
export function tabNavDelta(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}

/**
 * 环形位移，越界回卷。`index < 0`（当前值不在列表里）时从 0 起步，
 * 这样「无选中」状态下按方向键也能落到第一项，而不是原地不动。
 */
export function nextTabIndex(index: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  const current = index < 0 ? 0 : index;
  return (current + delta + length) % length;
}

/** 游标 tabindex：只有当前项是 0，其余 -1（Tab 键穿过整排只停一次） */
export function tabStopIndex(index: number, selectedIndex: number): 0 | -1 {
  return index === selectedIndex ? 0 : -1;
}
