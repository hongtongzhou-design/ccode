import { useState } from "react";
import { compactFieldClass, fieldClass } from "./PageFrame";
import { RESEARCH_TOOL_FIELDS, type ResearchToolField, type ResearchTools } from "../research-tools";

export default function ResearchToolFields({
  value, onChange, disabled = false, fields = RESEARCH_TOOL_FIELDS, collapsible = true, defaultOpen = false,
}: {
  value: ResearchTools; onChange: (next: ResearchTools) => void; disabled?: boolean;
  fields?: readonly ResearchToolField[]; collapsible?: boolean;
  /** 仅折叠态：已选过非默认交付时展开，避免把既有选择藏起来 */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (fields.length === 0) return null;
  const selects = fields.map((field) =>
    <label key={field.key} className="block">
      <span className={collapsible ? "text-l3" : "mb-1 block text-xs text-l2"}>{field.label}</span>
      <select disabled={disabled} value={value[field.key]} onChange={(e) => onChange({ ...value, [field.key]: e.target.value })} className={collapsible ? `mt-1 w-full ${compactFieldClass}` : fieldClass}>
        {field.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </label>);
  if (!collapsible) return <>{selects}</>;
  const hasManuscript = fields.some((field) => field.key === "manuscript");
  return <details className="rounded-md ccode-well p-3 text-xs" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium text-l2" title="文献从哪来请在检索步骤的「确定文献来源」里选。">
      {hasManuscript ? "稿件载体与外部工具（按需选择）" : "按需补齐交付"}
    </summary>
    <p className="my-2 text-l3">{hasManuscript ? "按需补齐交付；不会安装或授权写库。" : "不会安装或授权写库。"}</p>
    <div className="grid gap-2 sm:grid-cols-2">{selects}</div>
  </details>;
}
