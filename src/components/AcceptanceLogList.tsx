import { useState } from "react";
import {
  acceptanceEntryHeadline,
  acceptanceEntryKey,
} from "../acceptance-log";
import {
  acceptanceLogView,
  recentAcceptanceLog,
} from "../project-status";
import { absTime, relTime } from "../rel-time";
import type { AcceptanceLogEntryDto } from "../types";
import { FoldMark } from "./PageFrame";

/** 任务页只读账本：科研 / 编程 / 目标共用，不另开页签。 */
export default function AcceptanceLogList({
  entries,
  className = "mt-4",
}: {
  entries: readonly AcceptanceLogEntryDto[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const recent = recentAcceptanceLog(entries);
  if (recent.length === 0) return null;
  return (
    <div className={className}>
      <button
        type="button"
        className="mb-2 flex items-center gap-1 text-micro font-medium text-l4 hover:text-l2"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <FoldMark open={open} />
        验收记录 {entries.length}
      </button>
      {open && (
        <ul className="space-y-2">
          {recent.map((entry) => {
            const view = acceptanceLogView(entry);
            return (
              <li key={acceptanceEntryKey(entry)} className="px-1">
                <span className="block text-xs text-l2">
                  {acceptanceEntryHeadline(entry)}
                  <span className="text-l4"> · {view.filesLabel}</span>
                </span>
                {view.note && (
                  <span className="mt-0.5 block text-micro text-l3">
                    {view.note}
                  </span>
                )}
                <span
                  className="mt-0.5 block text-micro text-l4"
                  title={absTime(view.decidedAt)}
                >
                  {relTime(view.decidedAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
