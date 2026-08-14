import { useState } from "react";
import { skillOutputConflicts } from "../skill-conflicts";
import { useAppStore } from "../store";
import type { SkillDto } from "../types";

/**
 * 步骤「推荐技能」chip 区（v3.67）：步骤级 TASK.md 预览弹层（只读）与开工确认弹层（可编辑）共用。
 * 只读：chip 点击展开/收起一句话描述；可编辑（给了 onChange）：chip 带 × 移除 + 尾部「＋ 添加技能」下拉。
 * 增删的持久化由调用方负责（update_step_skills 写回 project.toml steps[].skills）。
 * mcpRecommended 命中的技能 chip 旁加「推荐 MCP」小标记，点击跳 MCP 页配置。
 * 给了 skillLib 时检测挂载技能的产物路径冲突（outputs 相交），chips 下方逐行 ⚠ 提示（v3.79）。
 */
export default function StepSkillsChips({
  skills,
  skillMeta,
  available,
  mcpRecommended,
  skillLib,
  onChange,
}: {
  /** 步骤当前挂载的技能名（project.toml steps[].skills） */
  skills: string[];
  /** 技能库元数据（name → 一句话描述）；缺省时 chip 只显示名字 */
  skillMeta: Record<string, string> | undefined;
  /** 可编辑时的候选清单（已安装技能名，调用方排除已挂载与否均可，组件内再过滤一次） */
  available?: string[];
  /** SKILL.md 提及 MCP 工具的技能名（后端内容扫描）：chip 旁显示「推荐 MCP」标记 */
  mcpRecommended?: string[];
  /** 技能库完整条目（产物冲突检测用；缺省 = 不检测） */
  skillLib?: SkillDto[] | null;
  /** 提供 = 可编辑模式；增删后的完整 skills 数组经此回调 */
  onChange?: (next: string[]) => void;
}) {
  // 只读模式下点击 chip 展开描述（按技能名记忆展开态）
  const [expanded, setExpanded] = useState<string | null>(null);
  const setPage = useAppStore((s) => s.setPage);
  const editable = !!onChange;
  const candidates = (available ?? []).filter((name) => !skills.includes(name));
  const outputConflicts = skillLib ? skillOutputConflicts(skills, skillLib) : [];
  if (skills.length === 0 && !editable) return null;
  return (
    <div className="mb-3 shrink-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-l3">推荐技能</span>
        <span className="text-micro text-l4">
          {editable
            ? "增删写回步骤定义（project.toml），影响以后所有开工"
            : "点击技能名看一句话说明"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {skills.map((name) => {
          const desc = skillMeta?.[name];
          const open = expanded === name && !editable;
          const label = (
            <>
              {name}
              {!(name in (skillMeta ?? {})) && (
                <span className="text-micro text-l4">（未安装）</span>
              )}
            </>
          );
          const chipClass =
            "flex items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-micro text-l2";
          return (
            <span key={name} className="flex flex-col">
              <span className="flex items-center gap-1">
                {editable ? (
                  <span className={chipClass} title={desc ?? name}>
                    {label}
                    <button
                      type="button"
                      aria-label={`移除技能 ${name}`}
                      title="从步骤定义移除"
                      onClick={() => onChange(skills.filter((s) => s !== name))}
                      className="rounded-sm px-0.5 text-l4 hover:text-l1"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : name)}
                    title={open ? "收起说明" : (desc ?? "查看说明")}
                    className={`${chipClass} hover:bg-hover`}
                  >
                    {label}
                  </button>
                )}
                {mcpRecommended?.includes(name) && (
                  <button
                    type="button"
                    onClick={() => setPage("mcp")}
                    title="该技能推荐使用 MCP 工具，到 MCP 页配置"
                    className="rounded-sm bg-strip px-1 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
                  >
                    推荐 MCP
                  </button>
                )}
              </span>
              {open && desc && (
                <span className="max-w-72 px-1.5 py-0.5 text-micro text-l4">
                  {desc}
                </span>
              )}
            </span>
          );
        })}
        {editable && candidates.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const name = e.target.value;
              if (name) onChange([...skills, name]);
            }}
            title="添加技能到步骤定义"
            className="h-6 rounded-md border border-field bg-canvas px-1 text-micro text-l4 outline-none focus:border-l4"
          >
            <option value="">＋ 添加技能</option>
            {candidates.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      {outputConflicts.map((c) => (
        <p key={`${c.a}|${c.b}`} className="mt-1 text-micro text-warn-text">
          ⚠ 技能「{c.a}」与「{c.b}」的产物都指向 {c.output}
          ——确认步骤简报里写明了分工（如“按 {c.a} 执行、{c.b} 只出报告”）
        </p>
      ))}
    </div>
  );
}
