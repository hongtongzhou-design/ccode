import { useState } from "react";

/**
 * 步骤「推荐技能」chip 区（v3.67）：步骤级 TASK.md 预览弹层（只读）与开工确认弹层（可编辑）共用。
 * 只读：chip 点击展开/收起一句话描述；可编辑（给了 onChange）：chip 带 × 移除 + 尾部「＋ 添加技能」下拉。
 * 增删的持久化由调用方负责（update_step_skills 写回 project.toml steps[].skills）。
 */
export default function StepSkillsChips({
  skills,
  skillMeta,
  available,
  onChange,
}: {
  /** 步骤当前挂载的技能名（project.toml steps[].skills） */
  skills: string[];
  /** 技能库元数据（name → 一句话描述）；缺省时 chip 只显示名字 */
  skillMeta: Record<string, string> | undefined;
  /** 可编辑时的候选清单（已安装技能名，调用方排除已挂载与否均可，组件内再过滤一次） */
  available?: string[];
  /** 提供 = 可编辑模式；增删后的完整 skills 数组经此回调 */
  onChange?: (next: string[]) => void;
}) {
  // 只读模式下点击 chip 展开描述（按技能名记忆展开态）
  const [expanded, setExpanded] = useState<string | null>(null);
  const editable = !!onChange;
  const candidates = (available ?? []).filter((name) => !skills.includes(name));
  if (skills.length === 0 && !editable) return null;
  return (
    <div className="mb-3 shrink-0">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs text-l3">推荐技能</span>
        <span className="text-[10px] text-l4">
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
                <span className="text-[10px] text-l4">（未安装）</span>
              )}
            </>
          );
          const chipClass =
            "flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-[11px] text-l2";
          return (
            <span key={name} className="flex flex-col">
              {editable ? (
                <span className={chipClass} title={desc ?? name}>
                  {label}
                  <button
                    type="button"
                    aria-label={`移除技能 ${name}`}
                    title="从步骤定义移除"
                    onClick={() => onChange(skills.filter((s) => s !== name))}
                    className="rounded px-0.5 text-l4 hover:text-l1"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : name)}
                  title={open ? "收起说明" : (desc ?? "查看说明")}
                  className={`${chipClass} hover:bg-white/5`}
                >
                  {label}
                </button>
              )}
              {open && desc && (
                <span className="max-w-72 px-1.5 py-0.5 text-[10px] text-l4">
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
            className="h-6 rounded-md border border-field bg-canvas px-1 text-[11px] text-l4 outline-none focus:border-l4"
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
    </div>
  );
}
