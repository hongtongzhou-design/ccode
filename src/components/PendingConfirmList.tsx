import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DirEntryDto } from "./FileTree";
import { researchAbsolutePath } from "../research-report";
import { readResearchFile } from "../research-report-load";
import {
  appendEndnoteImportRecord,
  appendToFetchEntry,
  confirmReason,
  includedMdLine,
  includedRecordKey,
  includedRecordMeta,
  includeAllPendingJson,
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

export type PendingConfirmHandle = {
  includeAll: () => void;
};

export default forwardRef<PendingConfirmHandle, {
  worktreePath?: string | null;
  projectRoot: string;
  onOpenPdf?: (path: string) => void;
  onChanged?: () => void;
  onMeta?: (meta: { count: number; busy: boolean }) => void;
}>(function PendingConfirmList({
  worktreePath,
  projectRoot,
  onOpenPdf,
  onChanged,
  onMeta,
}, ref) {
  const roots = [...new Set([worktreePath, projectRoot].filter((p): p is string => Boolean(p)))];
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [includingAll, setIncludingAll] = useState(false);
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

  useEffect(() => {
    onMeta?.({ count: pending.length, busy: includingAll || busyKey != null });
  }, [pending.length, includingAll, busyKey]);

  async function appendImport(rows: IncludedRecord[]) {
    const file = await readFirst([jsonRoot, ...roots], "papers/endnote-import.ris");
    if (!file?.file.revision) return;
    const chunks: string[] = [];
    for (const root of [file.root, ...roots]) {
      const listed = await invoke<DirEntryDto[]>("list_dir", {
        path: researchAbsolutePath(root, "papers/imports"),
        showHidden: false,
        root,
      }).catch(() => [] as DirEntryDto[]);
      for (const entry of listed) {
        if (entry.isDir || !entry.name.toLowerCase().endsWith(".ris")) continue;
        const text = await readResearchFile(root, `papers/imports/${entry.name}`).catch(() => null);
        if (text && !text.truncated) chunks.push(text.text);
      }
      if (chunks.length > 0) break;
    }
    const source = chunks.join("\n");
    let next = file.file.text;
    for (const row of rows) next = appendEndnoteImportRecord(next, row, source);
    if (next !== file.file.text) {
      await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(file.root, "papers/endnote-import.ris"),
        root: file.root,
        text: next,
        expectedRevision: file.file.revision,
      });
    }
    const zotero = await readFirst([file.root, ...roots], "papers/to-fetch.ris");
    if (!zotero?.file.revision) return;
    let znext = zotero.file.text;
    for (const row of rows) znext = appendEndnoteImportRecord(znext, row, source);
    if (znext === zotero.file.text) return;
    await invoke<string>("save_file_preview", {
      path: researchAbsolutePath(zotero.root, "papers/to-fetch.ris"),
      root: zotero.root,
      text: znext,
      expectedRevision: zotero.file.revision,
    });
  }

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
      if (decision === "included") {
        await appendImport([row]);
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

  async function includeAll() {
    if (!jsonRevision || pending.length === 0) return;
    setIncludingAll(true);
    setError(null);
    try {
      const nextJson = includeAllPendingJson(jsonText);
      const nextJsonRev = await invoke<string>("save_file_preview", {
        path: researchAbsolutePath(jsonRoot, "papers/included.json"),
        root: jsonRoot,
        text: nextJson,
        expectedRevision: jsonRevision,
      });
      setJsonText(nextJson);
      setJsonRevision(nextJsonRev);
      setRecords(parseIncludedRecords(nextJson));
      let nextMd = mdText;
      let nextMdRev = mdRevision;
      if (nextMd != null && nextMdRev) {
        for (const row of pending) {
          nextMd = patchIncludedMd(nextMd, row.title, "included", includedMdLine(row));
        }
        nextMdRev = await invoke<string>("save_file_preview", {
          path: researchAbsolutePath(jsonRoot, "papers/included.md"),
          root: jsonRoot,
          text: nextMd,
          expectedRevision: nextMdRev,
        });
        setMdText(nextMd);
        setMdRevision(nextMdRev);
      }
      await appendImport(pending);
      const missing = pending.filter((row) => !paperHasDoiPdf(row, pdfFiles));
      if (missing.length > 0) {
        const fetch = await readFirst([jsonRoot, ...roots], "papers/to-fetch.md");
        if (!fetch?.file.revision) {
          setError("已全部纳入，但没有可写入的 to-fetch.md，缺 PDF 的篇目没进待获取。");
        } else {
          let nextFetch = fetch.file.text;
          for (const row of missing) nextFetch = appendToFetchEntry(nextFetch, row);
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
      setIncludingAll(false);
    }
  }

  useImperativeHandle(ref, () => ({ includeAll: () => void includeAll() }));

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
                disabled={busyKey === key || includingAll}
                onClick={() => void confirmRow(row, "included")}
                className="rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text disabled:opacity-50"
              >
                纳入
              </button>
              <button
                type="button"
                disabled={busyKey === key || includingAll}
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
});
