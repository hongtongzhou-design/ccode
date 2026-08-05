import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// textLayer 的官方样式（选区/定位规则）；随本组件进懒加载 chunk
import "pdfjs-dist/web/pdf_viewer.css";

// vite 惯例：worker 走 ?url 资源，不进主包（本组件整体被动态 import）
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfBytesDto {
  data: string; // base64（macOS WKWebView 的 raw bytes 响应会退化成数字数组，故走字符串）
  size: number;
}

/** base64 → Uint8Array（atob 分块，避免大文件一次性函数调用栈/参数上限） */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) {
    const slice = bin.slice(i, i + CHUNK);
    for (let j = 0; j < slice.length; j++) out[i + j] = slice.charCodeAt(j);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 单页视图：canvas 渲染 + textLayer 选区层；display:none 时保持已渲染内容不销毁 */
function PdfPageView({
  doc,
  pageNum,
  scale,
  active,
  renderKey,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  active: boolean;
  /** scale 之外的强制重渲染信号（适配宽度随容器尺寸变化） */
  renderKey: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const host = hostRef.current!;
        host.style.width = `${Math.floor(viewport.width)}px`;
        host.style.height = `${Math.floor(viewport.height)}px`;
        // textLayer 字号按 --total-scale-factor 换算（pdf_viewer.css 的变量约定）
        host.style.setProperty("--total-scale-factor", String(scale));
        renderTask = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        const text = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textRef.current!,
          viewport,
        });
        textLayer = text;
        await Promise.all([renderTask.promise, text.render()]);
      } catch (e) {
        // 取消渲染不算错误（翻页/缩放打断上一帧）
        if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) {
          setError(String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [doc, pageNum, scale, renderKey]);

  return (
    <div
      ref={hostRef}
      data-page-num={pageNum}
      className={`relative bg-white ${active ? "" : "hidden"}`}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textRef} className="textLayer" />
      {error && (
        <p className="absolute inset-x-0 top-0 bg-strip px-3 py-1 text-xs text-err-text">
          第 {pageNum} 页渲染失败：{error}
        </p>
      )}
    </div>
  );
}

/** 「整理为笔记」结果：ok 决定是否清空选区；action 为可选快捷入口（如未登记时跳工作区页） */
export interface PdfActionResult {
  ok: boolean;
  msg: string;
  action?: { label: string; run: () => void };
}

/** 浮动按钮旁展示的轻量提示（可带一个快捷动作） */
interface Hint {
  msg: string;
  action?: { label: string; run: () => void };
}

/**
 * PDF 内嵌预览（§11.4 P2a）：pdf.js canvas + textLayer（可选区），
 * 只渲染当前页与相邻页（大 PDF 不做整本渲染）。
 * 字节经 read_pdf_bytes 加载（后端四类白名单约束）；选中文字出现浮动按钮：
 * 「◈ 问 AI」把选段 + 出处交给调用方写入活跃终端输入（不自动发送）；
 * 「整理为笔记」把选段追加到归属项目的笔记工作区（P2b，由调用方实现）。
 */
function PdfPreview({
  path,
  cwdHint,
  onAskAi,
  onOrganize,
}: {
  path: string;
  /** 终端标签 cwd / 文件树根：后端白名单的第四类来源 */
  cwdHint: string | null;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent） */
  onAskAi?: (text: string, page: number, fileName: string) => string | null;
  /** P2b：整理为笔记；返回展示给用户的提示（ok 决定是否清空选区） */
  onOrganize?: (
    text: string,
    page: number,
    fileName: string,
  ) => Promise<PdfActionResult>;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  /** null = 适配宽度模式（随容器宽度换算） */
  const [fixedScale, setFixedScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [renderKey, setRenderKey] = useState(0);
  const [hint, setHint] = useState<Hint | null>(null);
  const [askBtn, setAskBtn] = useState<{ x: number; y: number } | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scale = fixedScale ?? fitScale;

  const fileName = basename(path);

  // 加载文档（路径切换整体重来）
  useEffect(() => {
    let cancelled = false;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setError(null);
    setPageNum(1);
    setPageInput("1");
    setFixedScale(null);
    setAskBtn(null);
    void (async () => {
      try {
        const dto = await invoke<PdfBytesDto>("read_pdf_bytes", {
          path,
          cwdHint,
        });
        if (cancelled) return;
        task = pdfjs.getDocument({ data: base64ToBytes(dto.data) });
        const loaded = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        setPageCount(loaded.numPages);
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [path, cwdHint]);

  // 适配宽度：量首页原始宽度换算 scale；容器尺寸变化（分栏拖拽）时重算
  useEffect(() => {
    if (!doc || fixedScale !== null) return;
    const el = scrollRef.current;
    if (!el) return;
    let cancelled = false;
    const compute = async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const w = page.getViewport({ scale: 1 }).width;
        const avail = el.clientWidth - 24; // 左右留白
        if (w > 0 && avail > 0) setFitScale(avail / w);
      } catch {
        /* 页读取失败交给渲染层报错 */
      }
    };
    void compute();
    const ro = new ResizeObserver(() => {
      void compute();
      setRenderKey((k) => k + 1);
    });
    ro.observe(el);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [doc, pageNum, fixedScale]);

  // 翻页后回到内容顶部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [pageNum, scale]);

  const showHint = useCallback((h: Hint) => {
    setHint(h);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  // 选区监听：在 PDF 内容区内选中文字 → 跟随选区末端显示「◈ 问 AI」；失选/收起即消失
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const scroll = scrollRef.current;
      if (!sel || sel.isCollapsed || !scroll) {
        setAskBtn(null);
        return;
      }
      const node = sel.anchorNode;
      const el =
        node?.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement;
      if (!el || !scroll.contains(el) || !el.closest("[data-page-num]")) {
        setAskBtn(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      const sr = scroll.getBoundingClientRect();
      setAskBtn({
        // 两个按钮并排的宽度预留约 170px，避免右缘溢出
        x: Math.max(
          8,
          Math.min(r.right - sr.left + scroll.scrollLeft - 72, sr.width - 170),
        ),
        y: r.bottom - sr.top + scroll.scrollTop + 6,
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  /** 抽取当前选段与所在页码（锚点落在 textLayer 的 data-page-num 节点上） */
  function selectedExcerpt(): { text: string; page: number } | null {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!text || !sel) return null;
    const node = sel.anchorNode;
    const el =
      node?.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node?.parentElement;
    const page =
      Number(el?.closest("[data-page-num]")?.getAttribute("data-page-num")) ||
      pageNum;
    return { text, page };
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    setAskBtn(null);
  }

  function askAi() {
    const excerpt = selectedExcerpt();
    if (!excerpt) return;
    const err =
      onAskAi?.(excerpt.text, excerpt.page, fileName) ?? "当前页面不支持问 AI";
    showHint({ msg: err ?? "已写入活跃终端的输入框，检查后自行发送" });
    if (!err) clearSelection();
  }

  /** P2b：选段 → 归属项目的笔记工作区 notes/inbox.md；失败不静默（提示条展示原因） */
  async function organize() {
    if (organizing) return;
    const excerpt = selectedExcerpt();
    if (!excerpt || !onOrganize) return;
    setOrganizing(true);
    try {
      const r = await onOrganize(excerpt.text, excerpt.page, fileName);
      showHint({ msg: r.msg, action: r.action });
      if (r.ok) clearSelection();
    } catch (e) {
      showHint({ msg: `整理为笔记失败：${String(e)}` });
    } finally {
      setOrganizing(false);
    }
  }

  function goPage(n: number) {
    const next = Math.min(pageCount, Math.max(1, n));
    setPageNum(next);
    setPageInput(String(next));
  }

  const zoomBtn =
    "flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs text-l3 hover:bg-white/5 hover:text-l1 disabled:opacity-40";

  // 只挂载当前页 ±1（相邻页预渲染在隐藏状态，翻页即时可见），不整本渲染
  const pages = doc
    ? [pageNum - 1, pageNum, pageNum + 1].filter((n) => n >= 1 && n <= pageCount)
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {fileName}
        </span>
        <span className="shrink-0 rounded bg-inset px-1 text-l4">PDF</span>
        {doc && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              className={zoomBtn}
              disabled={pageNum <= 1}
              onClick={() => goPage(pageNum - 1)}
              title="上一页"
            >
              ‹
            </button>
            <input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pageInput) goPage(Number(pageInput));
              }}
              onBlur={() => setPageInput(String(pageNum))}
              className="w-9 rounded border border-field bg-canvas px-1 py-0.5 text-center text-xs text-l2 outline-none focus:border-l4"
            />
            <span className="text-l4">/ {pageCount}</span>
            <button
              className={zoomBtn}
              disabled={pageNum >= pageCount}
              onClick={() => goPage(pageNum + 1)}
              title="下一页"
            >
              ›
            </button>
            <span className="mx-1 h-3 w-px bg-hairline" />
            <button
              className={zoomBtn}
              onClick={() =>
                setFixedScale((s) => Math.max(0.25, (s ?? fitScale) / 1.2))
              }
              title="缩小"
            >
              −
            </button>
            <button
              className={`${zoomBtn} px-1.5 tabular-nums`}
              onClick={() => setFixedScale(null)}
              title="适配宽度"
            >
              {fixedScale === null ? "适配" : `${Math.round(scale * 100)}%`}
            </button>
            <button
              className={zoomBtn}
              onClick={() =>
                setFixedScale((s) => Math.min(4, (s ?? fitScale) * 1.2))
              }
              title="放大"
            >
              +
            </button>
          </span>
        )}
      </div>
      {hint && (
        <p className="flex shrink-0 items-center gap-2 bg-inset px-3 py-1 text-xs text-l2">
          <span className="min-w-0 flex-1 truncate" title={hint.msg}>
            {hint.msg}
          </span>
          {hint.action && (
            <button
              type="button"
              className="shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
              onClick={() => {
                hint.action!.run();
                setHint(null);
              }}
            >
              {hint.action.label}
            </button>
          )}
        </p>
      )}
      {error ? (
        <div className="p-3">
          <p className="text-sm text-err-text">{error}</p>
        </div>
      ) : !doc ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载 PDF…</p>
        </div>
      ) : (
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
          <div className="flex min-w-max flex-col items-center p-3">
            {pages.map((n) => (
              <PdfPageView
                key={`${n}-${scale.toFixed(3)}-${renderKey}`}
                doc={doc}
                pageNum={n}
                scale={scale}
                active={n === pageNum}
                renderKey={renderKey}
              />
            ))}
          </div>
          {askBtn && (onAskAi || onOrganize) && (
            <div
              style={{ left: askBtn.x, top: askBtn.y }}
              className="absolute z-10 flex gap-1"
            >
              {onAskAi && (
                <button
                  type="button"
                  // preventDefault 保住选区，click 时才读文字
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={askAi}
                  className="rounded border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
                >
                  ◈ 问 AI
                </button>
              )}
              {onOrganize && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void organize()}
                  disabled={organizing}
                  className="rounded border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                >
                  {organizing ? "整理中…" : "整理为笔记"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 pdf.js 渲染管线 */
export default memo(PdfPreview);
