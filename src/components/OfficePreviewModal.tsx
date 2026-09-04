import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { hydrateMdImages } from "../md-image-hydrate";
import { renderMathInto } from "../md-math";
import { rewriteMdImageHtml } from "../reader";
import { officePreviewMode } from "../work-mode";
import { rowActionClass } from "./PageFrame";
import PdfContinuousView from "./PdfContinuousView";
import DocxPreview from "./DocxPreview";
import XlsxPreview from "./XlsxPreview";
import ImagePreview from "./ImagePreview";

export default function OfficePreviewModal({
  path,
  root,
  onClose,
  onAskAi,
  extraAction,
}: {
  path: string;
  root: string;
  onClose: () => void;
  onAskAi?: () => void;
  extraAction?: { label: string; onClick: () => void };
}) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const mode = officePreviewMode(path);
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const mdRef = useRef<HTMLDivElement>(null);

  const isText = mode === "text";
  const isMarkdown = isText && /\.(md|markdown|mdx|qmd)$/i.test(name);

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    invoke<{ text: string; truncated: boolean }>("read_file_preview", {
      path,
      root,
    })
      .then((r) => {
        if (!cancelled) setText(r.text);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [isText, path, root]);

  useEffect(() => {
    if (text == null || !isMarkdown) return;
    const raw = marked.parse(text, { async: false }) as string;
    setHtml(rewriteMdImageHtml(raw));
  }, [text, isMarkdown]);

  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el) return;
    hydrateMdImages(el, { fromFile: path, cwdHint: root, allowHttps: true });
  });

  useEffect(() => {
    const el = mdRef.current;
    if (!el || !html) return;
    void renderMathInto(el);
  }, [html]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  let body: ReactNode;
  if (error) {
    body = <p className="text-sm text-err-text">{error}</p>;
  } else if (mode === "pdf") {
    body = (
      <PdfContinuousView path={path} cwdHint={root} maxFitMultiplier={1.5} />
    );
  } else if (mode === "image") {
    body = <ImagePreview path={path} cwdHint={root} />;
  } else if (mode === "xlsx") {
    body = <XlsxPreview path={path} cwdHint={root} compact />;
  } else if (mode === "docx") {
    body = <DocxPreview path={path} cwdHint={root} />;
  } else if (isMarkdown) {
    body =
      text == null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        <div
          ref={mdRef}
          className="md-body min-h-0 flex-1 overflow-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
  } else if (isText) {
    body =
      text == null ? (
        <p className="text-xs text-l4">读取中…</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-mono text-xs text-l2">
          {text}
        </pre>
      );
  } else {
    body = <p className="text-sm text-l3">这种文件请用系统应用打开。</p>;
  }

  return (
    <div
      className="ccode-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className={`ccode-float-surface flex w-full flex-col rounded-md border border-field ${
          mode === "xlsx"
            ? "h-[min(88vh,920px)] max-w-[min(96vw,1280px)] p-0"
            : "h-[80vh] max-w-4xl p-5"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`flex shrink-0 items-baseline gap-2 ${
            mode === "xlsx"
              ? "border-b border-hairline px-4 py-2.5"
              : "mb-3"
          }`}
        >
          <h2 className="min-w-0 truncate text-base font-semibold text-l1">
            {name}
          </h2>
          <span
            className="min-w-0 truncate font-mono text-micro text-l4"
            title={path}
          >
            {path}
          </span>
        </div>
        <div
          className={
            mode === "xlsx" || mode === "pdf"
              ? // pdf/xlsx 自带滚动容器与缩放锚点：外层只给有界高度、禁再滚动
                // （外层 overflow-auto 会让内层滚动容器撑到全文高度永不滚动，
                //   缩放锚点修正写进不滚的容器 = 错位；整篇超高内容还会触发
                //   WKWebView 瓦片黑屏）
                "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "min-h-0 flex-1 overflow-auto"
          }
        >
          {body}
        </div>
        <div
          className={`flex shrink-0 justify-end gap-2 ${
            mode === "xlsx" ? "border-t border-hairline px-4 py-2.5" : "mt-3"
          }`}
        >
          {extraAction && (
            <button
              type="button"
              className={rowActionClass}
              onClick={extraAction.onClick}
            >
              {extraAction.label}
            </button>
          )}
          {onAskAi && (
            <button type="button" className={rowActionClass} onClick={onAskAi}>
              问 AI
            </button>
          )}
          <button type="button" className={rowActionClass} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
