import { compactFieldClass } from "./PageFrame";
import { RESEARCH_TOOL_FIELDS, type ResearchTools } from "../research-tools";

export default function ResearchToolFields({ value, onChange, disabled = false }: {
  value: ResearchTools; onChange: (next: ResearchTools) => void; disabled?: boolean;
}) {
  return <details className="rounded-md ccode-well p-3 text-xs">
    <summary className="cursor-pointer font-medium text-l2">科研工具与稿件载体（按需选择）</summary>
    <p className="my-2 text-l3">按需补齐交付；不会安装或授权写库。</p>
    <div className="grid gap-2 sm:grid-cols-2">{RESEARCH_TOOL_FIELDS.map((field) =>
      <label key={field.key} className="block text-l3">{field.label}
        <select disabled={disabled} value={value[field.key]} onChange={(e) => onChange({ ...value, [field.key]: e.target.value })} className={`mt-1 w-full ${compactFieldClass}`}>
          {field.options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>)}</div>
  </details>;
}
