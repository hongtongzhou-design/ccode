/**
 * 定时巡检「技能」下拉与任务名默认值的纯逻辑（ScheduleSection 创建弹层用）。
 *
 * - 选项：lit-watch 恒在最前（技能库里没有也补一条兜底，它是调度器的默认技能）；
 * - 默认任务名跟随技能：lit-watch = 「文献雷达」，其他技能 = 技能名（库缺失兜底 id）；
 * - 跟随只发生在用户没手改过时（当前名为空或等于上一技能的默认名），手改的不覆盖。
 */
export interface ScheduleSkillOption {
  id: string;
  /** 技能显示名（SkillDto.name，可能未安装兜底为 id） */
  name: string;
}

interface SkillLike {
  id: string;
  name: string;
}

/** 下拉选项：lit-watch 固定最前，其余按技能库顺序 */
export function scheduleSkillOptions(
  skills: readonly SkillLike[],
): ScheduleSkillOption[] {
  const litWatch = skills.find((s) => s.id === "lit-watch");
  return [
    { id: "lit-watch", name: litWatch?.name ?? "lit-watch（文献监控）" },
    ...skills
      .filter((s) => s.id !== "lit-watch")
      .map((s) => ({ id: s.id, name: s.name })),
  ];
}

/** 默认任务名：lit-watch = 文献雷达；其他技能 = 技能显示名（库缺失兜底 id） */
export function defaultScheduleName(
  skillId: string,
  skills: readonly SkillLike[],
): string {
  if (skillId === "lit-watch") return "文献雷达";
  return skills.find((s) => s.id === skillId)?.name || skillId;
}

/** 切换技能时的任务名跟随：名为空或等于上一技能的默认名 = 未手改 → 跟随新默认；否则保留 */
export function followSkillName(
  currentName: string,
  prevSkillId: string,
  nextSkillId: string,
  skills: readonly SkillLike[],
): string {
  const untouched =
    currentName.trim() === "" ||
    currentName === defaultScheduleName(prevSkillId, skills);
  return untouched ? defaultScheduleName(nextSkillId, skills) : currentName;
}
