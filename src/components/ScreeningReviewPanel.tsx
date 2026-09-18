import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DirEntryDto } from "./FileTree";
import { extractResearchSections } from "../research-report";
import { readResearchFile } from "../research-report-load";
import {
  decisionBadge,
  filterIncludedRecords,
  includedRecordKey,
  includedRecordMeta,
  matchPaperPdf,
  parseIncludedRecords,
  screeningCountLine,
  screeningCounts,
  type IncludedRecord,
} from "../screening-review";
import { countToFetchEntries } from "../step-flow";
import PendingConfirmList from "./PendingConfirmList";

export default function ScreeningReviewPanel({
  root,
  projectRoot,
  onOpenPdf,
  onChanged,
  pane = "list",
  children,
}: {
  root: string;
  stepName?: string;
  projectRoot?: string;
  onOpenPdf?: (path: string) => void;
  onChanged?: () => void;
  onOpenFile?: (path: string) => void;
  pane?: "list" | "process";
  children?: ReactNode;
}) {
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<IncludedRecord[] | null>(null);
  const [toFetch, setToFetch] = useState(0);
  const [summary, setSummary] = useState("");
  const [quality, setQuality] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [pdfFiles, setPdfFiles] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRecords(null);
    void (async () => {
      try {
        const [json, fetchMd, screening] = await Promise.all([
          readResearchFile(root, "papers/included.json").catch(() => null),
          readResearchFile(root, "papers/to-fetch.md").catch(() => null),
          readResearchFile(root, "papers/screening.md").catch(() => null),
        ]);
        if (cancelled) return;
        if (!json) {
          setRecords([]);
          setError("未找到 papers/included.json。");
        } else {
          setRecords(parseIncludedRecords(json.text));
          if (json.truncated) setTruncated(true);
        }
        setToFetch(fetchMd ? countToFetchEntries(fetchMd.text) : 0);
        if (screening) {
          const sections = extractResearchSections(screening.text, "acceptance");
          setSummary(
            sections.find((s) => s.heading.includes("验收摘要"))?.text ?? "",
          );
          setQuality(
            sections.find((s) => s.heading.includes("质量状态"))?.text ?? "",
          );
          if (screening.truncated) setTruncated(true);
        }
        const pdfRoots = [...new Set([projectRoot, root].filter((p): p is string => Boolean(p)))];
        const listed = await Promise.all(
          pdfRoots.map((dir) =>
            invoke<DirEntryDto[]>("list_dir", {
              path: `${dir.replace(/[\\/]+$/, "")}/papers`,
              showHidden: false,
              root: dir,
            }).catch(() => [] as DirEntryDto[]),
          ),
        );
        if (cancelled) return;
        const pdfs: { name: string; path: string }[] = [];
        const seen = new Set<string>();
        for (const entries of listed) {
          for (const entry of entries) {
            if (entry.isDir || !entry.name.toLowerCase().endsWith(".pdf")) continue;
            if (seen.has(entry.path)) continue;
            seen.add(entry.path);
            pdfs.push({ name: entry.name, path: entry.path });
          }
        }
        setPdfFiles(pdfs);
      } catch (reason) {
        if (!cancelled) {
          setRecords([]);
          setError(String(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, root, reload]);

  const counts = useMemo(
    () => screeningCounts(records ?? [], toFetch),
    [records, toFetch],
  );
  const included = useMemo(
    () => filterIncludedRecords(records ?? [], "included"),
    [records],
  );
  const papersDir = projectRoot
    ? `${projectRoot.replace(/[\\/]+$/, "")}/papers`
    : undefined;

  return (
    <section aria-label="筛选结果" className="px-4 py-3 text-sm">
      <div className="mb-2 flex items-center justify-end">
        <button type="button" className="text-xs text-l3 hover:text-l1" onClick={() => setReload((n) => n + 1)}>
          刷新
        </button>
      </div>
      {records == null ? (
        <p className="text-l3">正在读取纳入清单…</p>
      ) : pane === "process" ? (
        <>
          <h4 className="font-medium text-l1">检索过程</h4>
          <p className="mt-1 text-xs text-l4">
            Agent 自述。未决可以保持未决，不挡保存进项目。
          </p>
          {(summary || quality) ? (
            <div className="mt-2 text-xs leading-5 text-l3">
              {quality && <p className="text-l2">质量状态：{quality}</p>}
              {summary && (
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans">
                  {summary}
                </pre>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-l4">没有检索过程摘要。</p>
          )}
        </>
      ) : (
        <>
          <p className="text-l2">{screeningCountLine(counts)}</p>
          {truncated && <p className="mt-1 text-xs text-warn-text">清单截断，摘要可能不完整。</p>}
          {error && <p className="mt-1 text-xs text-warn-text">{error}</p>}
          <p className="mt-3 text-xs text-l4">看纳入的篇目对不对。待确认仍可纳入或排除。</p>
          {counts.pending > 0 && (
            <div className="mt-2">
              <PendingConfirmList
                worktreePath={root}
                projectRoot={projectRoot || root}
                onOpenPdf={onOpenPdf}
                onChanged={() => {
                  setReload((n) => n + 1);
                  onChanged?.();
                }}
              />
            </div>
          )}
          <ul className="mt-2">
            {included.map((row) => {
              const key = includedRecordKey(row);
              const badge = decisionBadge(row.decision);
              const meta = includedRecordMeta(row);
              const pdfPath = matchPaperPdf(row, pdfFiles, papersDir);
              return (
                <li key={key} className="border-t border-hairline py-2">
                  {pdfPath && onOpenPdf ? (
                    <button
                      type="button"
                      className="text-left text-xs leading-5 text-cta-pill-text hover:underline"
                      onClick={() => onOpenPdf(pdfPath)}
                    >
                      {row.title}
                    </button>
                  ) : (
                    <p className="text-xs leading-5 text-l1">{row.title}</p>
                  )}
                  <p className="mt-0.5 text-micro text-ok-text">{badge.label}{meta ? ` · ${meta}` : ""}</p>
                </li>
              );
            })}
          </ul>
          {children}
        </>
      )}
    </section>
  );
}
