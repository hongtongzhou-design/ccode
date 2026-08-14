import type { SkillDto } from "./types";

/** 技能产物路径冲突检测（v3.79）：技能本质是 markdown 指导文件，内容级「职责重叠」无法自动判定；
 *  但 frontmatter outputs 声明的产物路径相撞（相同或互为前缀，如 papers/ 与 papers/inbox.md）
 *  意味着同一步骤的两个技能会往同一位置写、可能互相覆盖——这类冲突可以纯逻辑检出。
 *  数据源 = SkillDto.outputs（SKILL.md frontmatter，后端 list 时现算）；
 *  未声明 outputs 的技能（用户自建/外部导入）不参与检测。 */

export interface SkillOutputConflict {
  a: string;
  b: string;
  /** 相交的产物路径（取技能 a 侧声明的那条，已归一化） */
  output: string;
}

/** 归一化产物路径：去首尾空白、反斜杠统一为 /、折叠重复 /、去 ./ 前缀。目录尾斜杠保留 */
function normalizeOutput(raw: string): string {
  let p = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

/** 两条产物路径是否相交：完全相同，或一方落在另一方（按目录前缀含斜杠判定，papers/ 不误伤 papers2/） */
function outputsIntersect(x: string, y: string): boolean {
  const a = normalizeOutput(x);
  const b = normalizeOutput(y);
  if (!a || !b) return false;
  if (a === b) return true;
  const dirA = a.endsWith("/") ? a : `${a}/`;
  const dirB = b.endsWith("/") ? b : `${b}/`;
  return b.startsWith(dirA) || a.startsWith(dirB);
}

/** 两两比对该步骤已挂载技能的 outputs，返回产物路径相交的技能对。
 *  同一对技能多处相交只报一次（取第一对相交路径）；技能不在库中或 outputs 为空 → 不参与。 */
export function skillOutputConflicts(
  stepSkillNames: string[],
  lib: SkillDto[],
): SkillOutputConflict[] {
  const outputsOf = new Map(lib.map((s) => [s.name, s.outputs ?? []]));
  const out: SkillOutputConflict[] = [];
  for (let i = 0; i < stepSkillNames.length; i++) {
    const outsA = outputsOf.get(stepSkillNames[i]);
    if (!outsA?.length) continue;
    for (let j = i + 1; j < stepSkillNames.length; j++) {
      const outsB = outputsOf.get(stepSkillNames[j]);
      if (!outsB?.length) continue;
      const hit = outsA.find((oa) =>
        outsB.some((ob) => outputsIntersect(oa, ob)),
      );
      if (hit) {
        out.push({
          a: stepSkillNames[i],
          b: stepSkillNames[j],
          output: normalizeOutput(hit),
        });
      }
    }
  }
  return out;
}
