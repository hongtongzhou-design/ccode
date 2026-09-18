import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DirEntryDto } from "./FileTree";
import { researchAbsolutePath } from "../research-report";
import { readResearchFile } from "../research-report-load";
import {
  appendToFetchEntry,
  confirmReason,
  includedMdLine,
  includedRecordKey,
  includedRecordMeta,
  matchPaperPdf,
  paperHasDoiPdf,
  parseIncludedRecords,
  patchIncludedJson,
  patchIncludedMd,
  type IncludedRecord,
} from "../screening-review";

async function readFirst(roots: string[], rel: string) {
  for (const root of roots) {
    try {
      const file = await readResearchFile(root, rel);
      if (!file.truncated) return { root, file };
    } catch {
      /* 试下一处 */
    }
  }
  return null;
}

export default function PendingConfirmList({
  worktreePath,
  projectRoot,
  onOpenPdf,
  onChanged,
}: {
  worktreePath?: string | null;
  projectRoot: string;
  onOpenPdf?: (path: string) => void;
  onChanged?: () => void;
}) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [records, setRecords] = useState<IncludedRecord[] | null>(null);
  const [jsonRoot, setJsonRoot] = useState(projectRoot);
  const [jsonText, setJsonText] = useState("");
  const [jsonRevision, setJsonRevision] = useState<string | null>(null);
  const [mdText, setMdText] = useState<string | null>(null);
  const [mdRevision, setMdRevision] = useState<string | null>(null);
  const [pdfFiles, setPdfFiles] = useState<{ name: string; path: string }[]>([]);

  async function load() {
    setError(null);
    const json = await readFirst(roots, "papers/included.json");
    if (!json) {
      setRecords([]);
      setError("还没有 included.json。Agent 筛完会出现待确认清单。");
      return;
    }
    setJsonRoot(json.root);
    setJsonText(json.file.text);
    setJsonRevision(json.file.revision);
    setRecords(parseIncludedRecords(json.file.text));
    const md = await readFirst([json.root, ...roots], "papers/included.md");
    setMdText(md?.file.text ?? null);
    setMdRevision(md?.file.revision ?? null);
    const listed = await Promise.all(
      roots.map((dir) =>
        invoke<DirEntryDto[]>("list_dir", {
          path: `${dir.replace(/[\\/]+$/, "")}/papers`,
          showHidden: false,
          root: dir,
        }).catch(() => [] as DirEntryDto[]),
      ),
    );
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
  }

  useEffect(() => {
    void load();
  }, [worktreePath, projectRoot]);

  const pending = (records ?? []).filter((row) => row.decision === "pending");

  async function confirmRow(row: IncludedRecord, decision: "included" | "excluded") {
    if (!jsonRevision) return;
    const key = includedRecordKey(row);
    setBusyKey(key);
    setError(null);
    const reason = confirmReason(decision, row.reason);
    try {
      const nextJson = patchIncludedJson(jsonText, key, decision, reason);
      const nextJsonRev = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(jsonRoot, "papers/included.json"),
        root: jsonRoot,
        text: nextJson,
        expectedRevision: jsonRevision,
      });
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      if (mdText != null && mdRevision) {
        const nextMd = patchIncludedMd(mdText, row.title, decision, includedMdLine(row));
        const nextMdRev = await invoke<string>("save_file_preview", {
          path: researchAbsolutePath(jsonRoot, "papers/included.md"),
          root: jsonRoot,
          text: nextMd,
          expectedRevision: mdRevision,
        });
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      if (decision === "included" && !paperHasDoiPdf(row, pdfFiles)) {
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已纳入，但没有可写入的 to-fetch.md，无法追加待获取。");
        } else {
          const nextFetch = appendToFetchEntry(fetch.file.text, row);
          if (nextFetch !== fetch.file.text) {
            await invoke<string>("save_file_preview", {
              path: researchAbsolutePath(fetch.root, "papers/to-fetch.md"),
              root: fetch.root,
              text: nextFetch,
              expectedRevision: fetch.file.revision,
            });
          }
        }
      }
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyKey(null);
    }
  }

  if (records == null) return <p className="text-micro text-l4">加载待确认清单…</p>;
  if (error && pending.length === 0) return <p className="text-micro text-l4">{error}</p>;
  if (pending.length === 0) return <p className="text-micro text-l4">没有待确认篇目。</p>;

  return (
    <ul className="max-h-72 space-y-2 overflow-auto">
      {error && <li className="text-micro text-err-text">{error}</li>}
      {pending.map((row) => {
        const key = includedRecordKey(row);
        const pdfPath = matchPaperPdf(
          row,
          pdfFiles,
          `${projectRoot.replace(/[\\/]+$/, "")}/papers`,
        );
        const meta = includedRecordMeta(row);
        return (
          <li key={key} className="border-t border-hairline pt-2">
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
            {meta && <p className="mt-0.5 text-micro text-l4">{meta}</p>}
            {pdfPath && <p className="mt-0.5 text-micro text-ok-text">已有 PDF，点标题在文件页预览</p>}
            {!pdfPath && row.url && (
              <button
                type="button"
                className="mt-0.5 text-left text-micro text-cta-pill-text hover:underline"
                onClick={() => void openUrl(row.url)}
              >
                {row.url.replace(/^https?:\/\//, "")}
              </button>
            )}
            {row.reason && <p className="mt-0.5 text-micro leading-5 text-l3">{row.reason}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              <button
                type="button"
                disabled={busyKey === key}
                onClick={() => void confirmRow(row, "included")}
                className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
              >
                纳入
              </button>
              <button
                type="button"
                disabled={busyKey === key}
                onClick={() => void confirmRow(row, "excluded")}
                className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover disabled:opacity-50"
              >
                排除
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
