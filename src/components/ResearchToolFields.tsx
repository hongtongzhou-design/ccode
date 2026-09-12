import { compactFieldClass } from "./PageFrame";
import { RESEARCH_TOOL_FIELDS, type ResearchToolField, type ResearchTools } from "../research-tools";

export default function ResearchToolFields({
  value, onChange, disabled = false, fields = RESEARCH_TOOL_FIELDS, collapsible = true,
}: {
  value: ResearchTools; onChange: (next: ResearchTools) => void; disabled?: boolean;
  fields?: readonly ResearchToolField[]; collapsible?: boolean;
}) {
  if (fields.length === 0) return null;
  const body = <>
    <p className={collapsible ? "my-2 text-l3" : "mb-2 text-l3"}>按需补齐交付；不会安装或授权写库。</p>
    <div className="grid gap-2 sm:grid-cols-2">{fields.map((field) =>
      <label key={field.key} className="block text-l3">{field.label}
        <select disabled={disabled} value={value[field.key]} onChange={(e) => onChange({ ...value, [field.key]: e.target.value })} className={`mt-1 w-full ${compactFieldClass}`}>
          {field.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>)}</div>
  </>;
  if (!collapsible) return <div className="rounded-md ccode-well p-3 text-xs">{body}</div>;
  return <details className="rounded-md ccode-well p-3 text-xs">
    <summary className="cursor-pointer font-medium text-l2">稿件载体与外部工具（按需选择）</summary>
    {body}
  </details>;
}
