import { useEffect, useRef, useState } from "react";
import {
  DECISION_STATUS,
  formatDecisionAnswer,
  parseDecisionRecords,
  setDecisionAnswer,
  type DecisionStatus,
} from "../step-decisions";
import type { StepDecisionDto } from "../types";

const STATUSES = Object.keys(DECISION_STATUS) as DecisionStatus[];

type Draft = { status: DecisionStatus | ""; note: string; legacy: boolean };

function draftsFrom(text: string, decisions: StepDecisionDto[]): Record<string, Draft> {
  const records = parseDecisionRecords(text);
  return Object.fromEntries(decisions.map((d) => {
    const q = d.q.trim();
    const record = records.get(q);
    return [q, {
      status: record && record.status !== "legacy" ? record.status : "",
      note: record?.note ?? "",
      legacy: record?.status === "legacy",
    }];
  }));
}

export default function ResearchDecisionFields({ decisions, text, disabled, evidenceRevision = null, onChange }: {
  decisions: StepDecisionDto[]; text: string; disabled?: boolean; evidenceRevision?: string | null; onChange: (text: string) => void;
}) {
  const [drafts, setDrafts] = useState(() => draftsFrom(text, decisions));
  const sent = useRef(text);
  useEffect(() => {
    if (text !== sent.current) {
      sent.current = text;
      setDrafts(draftsFrom(text, decisions));
    }
  }, [text, decisions]);
  if (!decisions.length) return null;
  function commit(question: string, status: DecisionStatus | "", note: string, legacy = false) {
    const q = question.trim();
    setDrafts((old) => ({ ...old, [q]: { status, note, legacy } }));
    const value = status && note.trim() ? formatDecisionAnswer(status, note.trim(), evidenceRevision) : "";
    sent.current = setDecisionAnswer(sent.current, question, value);
    onChange(sent.current);
  }
  return <fieldset disabled={disabled} className="mb-3 space-y-2 rounded-md bg-inset p-3 text-xs">
    <legend className="px-1 font-medium text-l1">你的决定</legend>
    <p className="text-micro text-l4">状态与说明分开填写。待补或不批准不能开工；旧纯文本不会自动变成已批准。</p>
    {decisions.map((decision) => {
      const q = decision.q.trim();
      const draft = drafts[q] ?? { status: "" as const, note: "", legacy: false };
      const records = parseDecisionRecords(sent.current);
      const record = records.get(q);
      const stale = draft.legacy || (evidenceRevision && record && (record.status === "approve" || record.status === "prepare") && record.boundRevision !== evidenceRevision);
      return <div key={decision.q} className="space-y-1 text-l2">
        <span className="mb-1 block">{decision.q}</span>
        <label className="block">决定状态
          <select value={draft.status} onChange={(e) => commit(decision.q, e.target.value as DecisionStatus | "", draft.note)}
            className="mt-1 w-full rounded border border-field bg-canvas px-2 py-1 text-xs text-l1 disabled:opacity-50">
            <option value="">未选择</option>
            {STATUSES.map((key) => <option key={key} value={key}>{DECISION_STATUS[key]}</option>)}
          </select>
        </label>
        <label className="block">说明（范围／版本／证据位置）
          <input value={draft.note} onChange={(e) => commit(decision.q, draft.status, e.target.value, false)}
            placeholder="批准的范围、方案版本或待补内容"
            className="w-full rounded border border-field bg-canvas px-2 py-1 text-xs text-l1 disabled:opacity-50" />
        </label>
        {stale && <p className="text-micro text-warn-text">{draft.legacy ? "这是旧的纯文本记录，请重新选择状态，不会自动视为已批准。" : "依据版本已变化，需要重新确认。"}</p>}
      </div>;
    })}
  </fieldset>;
}
