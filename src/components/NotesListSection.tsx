import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BookOpen } from "lucide-react";
import {
  FoldMark,
  hoverRevealClass,
  projectWellClass,
  rowActionClass,
  searchFieldClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { absTime, relTime } from "../rel-time";
import {
  isProjectNotesPath,
  isUserNoteFile,
} from "../project-status";
import {
  compareNotes,
  LIST_PREVIEW_CAP,
  splitNoteSeq,
  type NoteSort,
} from "../lit-list";
import { buildFolderTree } from "../folder-groups";
import FolderGroupedList, { useFolderChrome } from "./FolderGroupedList";
import OfficePreviewModal from "./OfficePreviewModal";
import type { OfficeDocDto } from "../types";

export default function NotesListSection({
  projectPath,
  onOpenFromLit,
}: {
  projectPath: string;
  onOpenFromLit?: () => void;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const [notes, setNotes] = useState<OfficeDocDto[]>([]);
  const [preview, setPreview] = useState<OfficeDocDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<NoteSort>("seq");
  const folders = useFolderChrome(`notes:${projectPath}`);

  useEffect(() => {
    let cancelled = false;
    invoke<OfficeDocDto[]>("list_office_docs", { root: projectPath })
      .then((docs) => {
        if (cancelled) return;
        setNotes(
          docs.filter(
            (d) =>
              isProjectNotesPath(d.rel) && isUserNoteFile(d.name, false),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = notes.filter((n) => {
      if (!q) return true;
      const { seq, title } = splitNoteSeq(n.name);
      return (
        title.toLowerCase().includes(q) ||
        (seq != null && seq.includes(q)) ||
        n.name.toLowerCase().includes(q) ||
        n.rel.toLowerCase().includes(q)
      );
    });
    return [...filtered].sort((a, b) => compareNotes(a, b, sort));
  }, [notes, query, sort]);

  const tree = useMemo(
    () => buildFolderTree(rows, (n) => n.rel, "notes"),
    [rows],
  );

  async function immerse(path: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<{
        projectRoot: string;
        pdfPath: string;
        notePath: string;
      }>("reader_for_note", { notePath: path });
      setReaderReq({
        pdfPath: r.pdfPath,
        projectRoot: r.projectRoot,
        notePath: r.notePath,
      });
      setPage("terminal");
      setPreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left"
          onClick={() => notes.length > 0 && setOpen((v) => !v)}
          aria-expanded={notes.length > 0 ? open : undefined}
        >
          {notes.length > 0 && <FoldMark open={open} boxed />}
          <BookOpen size={14} strokeWidth={1.8} className="text-l4" />
          <h2 className="text-xs font-medium text-l2">
            笔记{notes.length > 0 ? `（${notes.length}）` : ""}
          </h2>
        </button>
        {open && notes.length > 0 && (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索笔记"
              className={`${searchFieldClass} ml-auto w-44`}
              aria-label="搜索笔记"
            />
            <div
              className="flex flex-wrap gap-1"
              role="radiogroup"
              aria-label="笔记排序"
            >
              <button
                type="button"
                role="radio"
                aria-checked={sort === "seq"}
                className={`${rowActionClass} ${
                  sort === "seq" ? "border-cta-bd text-l1" : ""
                }`}
                onClick={() => setSort("seq")}
              >
                编号
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={sort === "recent"}
                className={`${rowActionClass} ${
                  sort === "recent" ? "border-cta-bd text-l1" : ""
                }`}
                onClick={() => setSort("recent")}
              >
                最近
              </button>
            </div>
          </>
        )}
      </div>
      {error && <p className="mb-2 px-1 text-xs text-err-text">{error}</p>}
      {notes.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-1 py-2">
          <p className="text-xs text-l4">笔记 · 还没有</p>
          {onOpenFromLit && (
            <button
              type="button"
              className={rowActionClass}
              onClick={onOpenFromLit}
            >
              从文献开读
            </button>
          )}
        </div>
      ) : open ? (
        <div className={projectWellClass}>
          {rows.length === 0 ? (
            <p className="px-1 py-2 text-xs text-l4">没有匹配</p>
          ) : (
            <FolderGroupedList
              tree={tree}
              searching={!!query.trim()}
              expanded={folders.expanded}
              onToggle={folders.toggle}
              cap={LIST_PREVIEW_CAP}
              revealed={folders.revealed}
              onReveal={folders.reveal}
              rowKey={(n) => n.path}
              renderRow={(n) => {
                const { seq, title } = splitNoteSeq(n.name);
                return (
                  <li className="group grid min-h-10 grid-cols-[2rem_minmax(0,1fr)_4.5rem_auto] items-center gap-2 rounded-md px-2.5 hover:bg-hover">
                    <span className="w-8 shrink-0 text-right font-mono text-micro text-l4">
                      {seq ?? ""}
                    </span>
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-sm text-l2"
                      onClick={() => setPreview(n)}
                      title={n.rel}
                    >
                      {title}
                    </button>
                    <span
                      className="text-right text-micro text-l4"
                      title={absTime(n.modified)}
                    >
                      {relTime(n.modified)}
                    </span>
                    <span className="flex justify-end">
                      <button
                        type="button"
                        className={`${rowActionClass} ${hoverRevealClass} shrink-0 whitespace-nowrap`}
                        disabled={busy}
                        onClick={() => void immerse(n.path)}
                      >
                        ⛶ 沉浸阅读
                      </button>
                    </span>
                  </li>
                );
              }}
            />
          )}
        </div>
      ) : null}
      {preview && (
        <OfficePreviewModal
          path={preview.path}
          root={projectPath}
          onClose={() => setPreview(null)}
          extraAction={{
            label: busy ? "打开中…" : "⛶ 沉浸阅读",
            onClick: () => void immerse(preview.path),
          }}
        />
      )}
    </section>
  );
}
