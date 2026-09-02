import { memo, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// textLayer 的官方样式（选区/定位规则）；随本组件进懒加载 chunk
import "pdfjs-dist/web/pdf_viewer.css";
import SelectionFloatBar, { DistillSkillButton } from "./SelectionFloatBar";
import { HoverTip, useHoverTip } from "./HoverTip";
import { IS_WINDOWS } from "../hotkeys";
import {
  findGlossaryMatches,
  nextFitScale,
  type GlossaryEntry,
} from "../reader";

// vite 惯例：worker 走 ?url 资源，不进主包（本组件整体被动态 import）
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 打开 PDF 文档的单一入口（预览与连续滚动共用）。
 *  Windows WebView2 的 ImageDecoder 会把部分 JPEG/JBIG2 解成空白位图（整页白屏），
 *  关掉后走 pdf.js 自带解码；macOS WKWebView 无此问题，保持默认加速。 */
export function openPdfDocument(
  data: Uint8Array,
): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data,
    isImageDecoderSupported: !IS_WINDOWS,
  });
}

export interface PdfBytesDto {
  data: string; // base64（macOS WKWebView 的 raw bytes 响应会退化成数字数组，故走字符串）
  size: number;
}

/** base64 → Uint8Array（atob 分块，避免大文件一次性函数调用栈/参数上限）。
 *  export：阅读区的连续滚动视图（PdfContinuousView）同链路复用 */
export function base64ToBytes(b64: string): Uint8Array {
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

/** 单页视图：canvas 渲染 + textLayer 选区层；display:none 时保持已渲染内容不销毁。
 *  export：阅读区的连续滚动视图（PdfContinuousView）按页复用（active 恒 true） */
export function PdfPageView({
  doc,
  pageNum,
  scale,
  active,
  glossTerms,
}: {
  doc: pdfjs.PDFDocumentProxy;
  pageNum: number;
  scale: number;
  active: boolean;
  /** 生词高亮术语表（阅读区 B3；空/缺省不高亮） */
  glossTerms?: readonly GlossaryEntry[];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** textLayer 渲染完成信号（计数器）：术语高亮等它落地后再跑 */
  const [textRendered, setTextRendered] = useState(0);

  // 拖选时给 textLayer 挂 selecting 类（官方 viewer 的 TextLayerBuilder 同款）：
  // pdf_viewer.css 里 .selecting 的 endOfContent 会撑满整层接住指针，
  // 拖过末行之下选区仍能扩到页尾
  useEffect(() => {
    const layer = textRef.current;
    if (!layer) return;
    const on = () => layer.classList.add("selecting");
    const off = () => layer.classList.remove("selecting");
    layer.addEventListener("mousedown", on);
    document.addEventListener("pointerup", off);
    window.addEventListener("blur", off);
    return () => {
      layer.removeEventListener("mousedown", on);
      document.removeEventListener("pointerup", off);
      window.removeEventListener("blur", off);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    let drawLayer: pdfjs.DrawLayer | null = null;
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
        // textLayer 字号按 --total-scale-factor 换算（pdf_viewer.css 变量约定 =
        // 名义倍率 × userUnit，即 viewport.scale × viewport.userUnit）
        host.style.setProperty(
          "--total-scale-factor",
          String(viewport.scale * viewport.userUnit),
        );
        // pdf.js 默认 getContext("2d", { alpha: false })。Chromium/WebView2 在
        // 全局 color-scheme:dark 下会把不透明 canvas 合成白块（整页白屏）。
        // 先以 alpha:true 绑定，后续 getContext 只能拿到已有上下文、忽略新属性。
        const ctx = canvas.getContext("2d", {
          alpha: true,
          willReadFrequently: true,
        });
        if (!ctx) throw new Error("无法创建画布");
        renderTask = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        // pdf.js 的 TextLayer 只往容器 append 不清空：重渲染前先清，
        // 否则缩放/重排后选段与高亮都会叠出重复文本片
        textRef.current!.replaceChildren();
        const text = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textRef.current!,
          viewport,
        });
        textLayer = text;
        // 选区高亮交给 pdf.js v6 的 DrawLayer 自绘（整页 div + SVG clip 贴字形）：
        // 原生 ::selection 在 scaleX 变换的文本片上溢出/错位，官方 viewer 因此默认
        // enableSelectionRendering 自绘并关掉原生高亮（.selectionRendering，pdf_viewer.css）
        drawLayer = new pdfjs.DrawLayer({
          pageIndex: pageNum - 1,
          textLayer: textRef.current!,
        });
        drawLayer.setParent(host);
        await Promise.all([renderTask.promise, text.render()]);
        if (!cancelled) {
          // 页尾捕手（官方 viewer 的 endOfContent，配合上面 selecting 类生效）；
          // DrawLayer 的 MutationObserver 也靠它感知重渲染后重算选区高亮
          const end = document.createElement("div");
          end.className = "endOfContent";
          textRef.current!.append(end);
          setTextRendered((c) => c + 1);
        }
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
      drawLayer?.destroy();
    };
  }, [doc, pageNum, scale]);

  // 术语高亮：textLayer 落地后（或术语表增删后）对文本节点跑整词匹配，命中处包
  // <span class="ccode-gloss">（点状下划线，悬停释义由 PdfContinuousView 事件代理出 HoverTip）；
  // cleanup 先还原旧高亮再重包，幂等可重入
  useEffect(() => {
    const container = textRef.current;
    if (!container || textRendered === 0 || !glossTerms || glossTerms.length === 0) {
      return;
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const n = walker.currentNode as Text;
      if (!n.data.trim()) continue;
      if (n.parentElement?.closest(".ccode-gloss")) continue;
      nodes.push(n);
    }
    for (const node of nodes) {
      const matches = findGlossaryMatches(node.data, glossTerms);
      if (matches.length === 0) continue;
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of matches) {
        if (m.start > pos) {
          frag.append(document.createTextNode(node.data.slice(pos, m.start)));
        }
        const span = document.createElement("span");
        span.className = "ccode-gloss";
        span.dataset.meaning = m.meaning;
        span.textContent = node.data.slice(m.start, m.end);
        frag.append(span);
        pos = m.end;
      }
      frag.append(document.createTextNode(node.data.slice(pos)));
      node.parentNode?.replaceChild(frag, node);
    }
    return () => {
      container.querySelectorAll(".ccode-gloss").forEach((el) => {
        el.replaceWith(...Array.from(el.childNodes));
      });
      container.normalize();
    };
  }, [textRendered, glossTerms]);

  return (
    <div
      ref={hostRef}
      data-page-num={pageNum}
      className={`relative bg-white ${active ? "" : "hidden"}`}
    >
      <canvas ref={canvasRef} className="block bg-transparent" />
      {/* selectionRendering：关掉原生 ::selection（透明化），高亮由 DrawLayer 自绘 */}
      <div ref={textRef} className="textLayer selectionRendering" />
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
 * 「◈ 问 AI」把选段 + 出处交给调用方写入活跃终端输入（「↵ 直接发送」立即回车发送）；
 * 「整理为笔记」把选段追加到归属项目的笔记工作区（P2b，由调用方实现）。
 */
function PdfPreview({
  path,
  cwdHint,
  onAskAi,
  onOrganize,
  onOpenReader,
}: {
  path: string;
  /** 终端标签 cwd / 文件树根：后端白名单的第四类来源 */
  cwdHint: string | null;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent）。send=true 直接发送 */
  onAskAi?: (
    text: string,
    page: number,
    fileName: string,
    send?: boolean,
  ) => string | null;
  /** P2b：整理为笔记；返回展示给用户的提示（ok 决定是否清空选区） */
  onOrganize?: (
    text: string,
    page: number,
    fileName: string,
  ) => Promise<PdfActionResult>;
  /** 「⛶ 沉浸阅读」入口（批次 B1 阅读区）：归属项目解析与失败提示由调用方负责 */
  onOpenReader?: () => void;
}) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  /** null = 适配宽度模式（随容器宽度换算） */
  const [fixedScale, setFixedScale] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [hint, setHint] = useState<Hint | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 「⛶ 沉浸阅读」钮的应用内 tooltip（原生 title 在 WKWebView 上行为不稳定）
  const readerBtnRef = useRef<HTMLButtonElement>(null);
  const readerTip = useHoverTip(readerBtnRef);
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
    void (async () => {
      try {
        const dto = await invoke<PdfBytesDto>("read_pdf_bytes", {
          path,
          cwdHint,
        });
        if (cancelled) return;
        task = openPdfDocument(base64ToBytes(dto.data));
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
        const next = nextFitScale(w, avail, fitScaleRef.current);
        if (next !== null) setFitScale(next);
      } catch {
        /* 页读取失败交给渲染层报错 */
      }
    };
    void compute();
    const ro = new ResizeObserver(() => {
      void compute();
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

  // 选区浮动按钮条的监听/定位已抽为共享组件 SelectionFloatBar（md 阅读视图同款复用）

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

  // 清选区后 selectionchange 会自动收起浮动按钮条，无需手动隐藏
  function clearSelection() {
    window.getSelection()?.removeAllRanges();
  }

  function askAi(send?: boolean) {
    const excerpt = selectedExcerpt();
    if (!excerpt) return;
    const err =
      onAskAi?.(excerpt.text, excerpt.page, fileName, send) ??
      "当前页面不支持问 AI";
    showHint({
      msg:
        err ??
        (send ? "已发送到活跃终端" : "已写入活跃终端的输入框，检查后自行发送"),
    });
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
    "flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-40";

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
        <span className="shrink-0 rounded-sm bg-inset px-1 text-l4">PDF</span>
        {onOpenReader && (
          <>
            <button
              ref={readerBtnRef}
              type="button"
              onMouseEnter={readerTip.show}
              onMouseLeave={readerTip.hide}
              onClick={onOpenReader}
              className="flex h-6 shrink-0 items-center rounded-sm px-1.5 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              ⛶ 沉浸阅读
            </button>
            <HoverTip tip={readerTip.tip} text="笔记 · PDF · 对话 三栏并排" />
          </>
        )}
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
              className="w-9 rounded-sm border border-field bg-canvas px-1 py-0.5 text-center text-xs text-l2 outline-none focus:border-l4"
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
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-cta-text hover:brightness-110"
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
        <div
          ref={scrollRef}
          className="ccode-pdf-scroll relative min-h-0 flex-1 overflow-auto"
        >
          <div className="flex min-w-max flex-col items-center p-3">
            {pages.map((n) => (
              <PdfPageView
                key={n}
                doc={doc}
                pageNum={n}
                scale={scale}
                active={n === pageNum}
              />
            ))}
          </div>
          {(onAskAi || onOrganize) && (
            // 四个按钮并排的宽度预留约 350px，避免右缘溢出
            <SelectionFloatBar
              containerRef={scrollRef}
              withinSelector="[data-page-num]"
              reserveWidth={350}
            >
              {onAskAi && (
                <>
                  <button
                    type="button"
                    // preventDefault 保住选区，click 时才读文字
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => askAi()}
                    className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
                  >
                    ◈ 问 AI
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => askAi(true)}
                    className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    ↵ 直接发送
                  </button>
                </>
              )}
              {onOrganize && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void organize()}
                  disabled={organizing}
                  className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
                >
                  {organizing ? "整理中…" : "整理为笔记"}
                </button>
              )}
              <DistillSkillButton onHint={(m) => showHint({ msg: m })} />
            </SelectionFloatBar>
          )}
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 pdf.js 渲染管线 */
export default memo(PdfPreview);
