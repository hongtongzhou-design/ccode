import { memo, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cellRef, colLetter, sheetTruncationLabel } from "../sheet-preview";

interface SheetPreviewDto {
  sheet: string;
  sheets: string[];
  rows: string[][];
  truncated: boolean;
  size: number;
  totalRows?: number;
  totalCols?: number;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Excel / ODS 只读预览：指定工作表、最多 200 行 × 256 列。
 * 列字母/行号冻结，宽表横滑；点格子在顶栏看全文（WKWebView 没有 title 悬浮）。
 */
function XlsxPreview({
  path,
  cwdHint,
}: {
  path: string;
  cwdHint: string | null;
}) {
  const [requestedSheet, setRequestedSheet] = useState<string | null>(null);
  const [dto, setDto] = useState<SheetPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);

  useEffect(() => {
    setRequestedSheet(null);
    setSel(null);
    setDto(null);
    setError(null);
  }, [path, cwdHint]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const next = await invoke<SheetPreviewDto>("read_sheet_preview", {
          path,
          cwdHint,
          sheet: requestedSheet,
        });
        if (!cancelled) setDto(next);
      } catch (e) {
        if (!cancelled) {
          setDto(null);
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint, requestedSheet]);

  const colCount = dto?.rows.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
  const truncLabel = useMemo(() => {
    if (!dto) return null;
    return sheetTruncationLabel({
      shownRows: dto.rows.length,
      shownCols: colCount,
      totalRows: dto.totalRows ?? dto.rows.length,
      totalCols: dto.totalCols ?? colCount,
    });
  }, [dto, colCount]);
  const selectedText =
    sel && dto ? (dto.rows[sel.r]?.[sel.c] ?? "") : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
        {truncLabel && (
          <span className="shrink-0 text-l4">{truncLabel}</span>
        )}
      </div>
      {sel && selectedText !== null && (
        <div className="flex shrink-0 items-start gap-2 border-b border-hairline bg-inset px-3 py-1 text-xs">
          <span className="shrink-0 font-mono text-l4">{cellRef(sel.r, sel.c)}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-l2">
            {selectedText || "（空）"}
          </span>
        </div>
      )}
      {error ? (
        <div className="p-3">
          <p className="text-sm text-err-text">{error}</p>
        </div>
      ) : dto === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载表格…</p>
        </div>
      ) : dto.rows.length === 0 ? (
        <div className="p-3">
          <p className="text-sm text-l4">这张表是空的</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-separate border-spacing-0 text-micro text-l2">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5" />
                {Array.from({ length: colCount }, (_, ci) => (
                  <th
                    key={ci}
                    className="sticky top-0 z-20 min-w-16 border-b border-r border-hairline bg-strip px-1.5 py-0.5 text-center font-mono font-normal text-l4"
                  >
                    {colLetter(ci)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dto.rows.map((row, ri) => (
                <tr key={ri}>
                  <th className="sticky left-0 z-10 w-10 min-w-10 border-b border-r border-hairline bg-strip px-1 py-0.5 text-right font-mono font-normal tabular-nums text-l4">
                    {ri + 1}
                  </th>
                  {Array.from({ length: colCount }, (_, ci) => {
                    const active = sel?.r === ri && sel?.c === ci;
                    return (
                      <td
                        key={ci}
                        onClick={() => setSel({ r: ri, c: ci })}
                        className={`max-w-48 min-w-16 cursor-default truncate border-b border-r border-hairline px-1.5 py-0.5 tabular-nums ${
                          active ? "bg-seg-sel text-l1" : ri === 0 ? "bg-inset" : "bg-canvas"
                        }`}
                      >
                        {row[ci] ?? ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dto && dto.sheets.length > 1 && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-t border-hairline bg-strip px-1 py-0.5">
          {dto.sheets.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => {
                if (name === (requestedSheet ?? dto.sheet)) return;
                setSel(null);
                setRequestedSheet(name);
              }}
              className={`shrink-0 rounded-sm px-2 py-0.5 text-micro ${
                name === (requestedSheet ?? dto.sheet)
                  ? "bg-seg-sel text-l1"
                  : "text-l3 hover:bg-hover hover:text-l1"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(XlsxPreview);
