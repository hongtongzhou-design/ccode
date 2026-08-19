import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import ConversationView from "./ConversationView";
import { HoverTip, useHoverTip } from "./HoverTip";
import { LoadingRows, SegTabs } from "./PageFrame";
import ReaderToolsPanel from "./ReaderToolsPanel";
import { AGENTS } from "../types";
import {
  READER_PCT_DEFAULT_L,
  READER_PCT_DEFAULT_R,
  READER_SPLIT_L_KEY,
  READER_SPLIT_R_KEY,
  buildFigureTourPrompt,
  buildNotePolishPrompt,
  buildPageSummaryPrompt,
  buildReaderTranslatePrompt,
  bytesToBase64,
  clampReaderPct,
  formatPdfExcerptPrompt,
  formatReaderCapturePrompt,
  loadReaderDark,
  loadReaderPct,
  readerColumnWidths,
  relToProjectRoot,
  saveReaderDark,
  type GlossaryEntry,
  type ReaderOutlineItem,
  type ReaderTranslateKind,
  type ReaderTranslateResult,
  type ReaderTranslation,
} from "../reader";
import type { SessionLinkState, TabStatus } from "../pages/TerminalPage";

// Monaco 与 pdf.js 都不进主包：首次进入阅读区才加载（同终端页预览的懒加载姿势）
const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));
const PdfContinuousView = lazy(() => import("./PdfContinuousView"));

/** ensure_paper_note 的返回（notes/<slug>.md 建档：已存在原样返回，永不覆盖） */
interface PaperNoteDto {
  path: string;
  created: boolean;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 文献标题 = 文件名 stem（顶栏《》用） */
function stemOf(p: string): string {
  return basename(p).replace(/\.pdf$/i, "");
}

/** 顶栏图标钮（‹ › 收起/展开侧栏共用样式） */
const topBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1";

/**
 * 沉浸式阅读区（批次 B1 骨架）：全屏覆盖层，三栏「笔记 | PDF | Agent 对话」。
 * 挂在终端页内（fixed inset-0 z-40 页面模态档），Esc 退出；底下终端/PTY/右栏全程保持挂载。
 * 本组件只管布局与栏内拼装：会话数据/注入/自动起会话都在 TerminalPage（与右栏同一数据源）。
 */
export default function ReaderOverlay({
  pdfPath,
  projectRoot,
  hasAgentTab,
  agentStatus,
  agentSession,
  needsProfile,
  onInject,
  onRestartAgent,
  onGoProfiles,
  onClose,
}: {
  pdfPath: string;
  projectRoot: string;
  /** 阅读会话标签是否还在（在但没上报状态 = 正在启动；不在 = 被手动关掉） */
  hasAgentTab: boolean;
  /** 阅读会话标签状态（还没建起/未上报为 null） */
  agentStatus: TabStatus | null;
  /** 会话联动数据（与终端页右栏「对话」页签同一来源/同一轮询节奏） */
  agentSession: SessionLinkState | null;
  /** 没有任何可用配置：Agent 栏显示引导卡 */
  needsProfile: boolean;
  /** 写入阅读会话 PTY（send=true 补 \r 直接发送）；返回 null 成功，否则为提示 */
  onInject: (data: string, send?: boolean) => string | null;
  /** 阅读会话标签被关掉后的「重新启动」（清空一次性标记让 TerminalPage 再派一次） */
  onRestartAgent: () => void;
  onGoProfiles: () => void;
  onClose: () => void;
}) {
  const stem = stemOf(pdfPath);

  // Esc 退出（阅读区优先于专注模式等退出：TerminalPage 的专注 Esc 在阅读区打开时不拦）；
  // isComposing 守卫：中文输入法组词中按 Esc 是取消候选，不关阅读区
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ===== 侧栏收起与分隔条拖拽（宽度百分比记 localStorage） =====
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [pctL, setPctL] = useState(() =>
    loadReaderPct(READER_SPLIT_L_KEY, READER_PCT_DEFAULT_L),
  );
  const [pctR, setPctR] = useState(() =>
    loadReaderPct(READER_SPLIT_R_KEY, READER_PCT_DEFAULT_R),
  );
  const areaRef = useRef<HTMLDivElement>(null);
  // 初始值直接取窗口宽（覆盖层恒为全窗口宽）：避免首帧按 0 渲染成只剩 PDF 栏的闪帧
  const [areaW, setAreaW] = useState(() => window.innerWidth);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    setAreaW(el.clientWidth);
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { left: leftPx, right: rightPx } = readerColumnWidths(areaW, pctL, pctR);
  // 极端窄窗（PDF 保底都拿不出）时换算结果为 0：侧栏整栏让位，只留 PDF
  const showLeft = leftOpen && leftPx > 0;
  const showRight = rightOpen && rightPx > 0;

  /** 分隔条拖拽（仿终端页 startSplitResize 的 pointer 模式；松手才落 localStorage） */
  function startSideResize(
    side: "left" | "right",
    event: React.PointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const setPct = side === "left" ? setPctL : setPctR;
    const key = side === "left" ? READER_SPLIT_L_KEY : READER_SPLIT_R_KEY;
    const fallback = side === "left" ? pctL : pctR;
    const pctOf = (clientX: number) =>
      clampReaderPct(
        side === "left"
          ? ((clientX - rect.left) / rect.width) * 100
          : ((rect.right - clientX) / rect.width) * 100,
        fallback,
      );
    const onMove = (moveEvent: PointerEvent) => setPct(pctOf(moveEvent.clientX));
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalPct = pctOf(upEvent.clientX);
      setPct(finalPct);
      localStorage.setItem(key, String(Math.round(finalPct)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  const splitter = (side: "left" | "right") => (
    <div
      onPointerDown={(e) => startSideResize(side, e)}
      className="group relative w-1.5 shrink-0 cursor-col-resize"
    >
      {/* 平时透明极细（w-0.5），悬停才显色（终端页同款手法）；外层 w-1.5 只是抓取热区 */}
      <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
    </div>
  );

  // ===== 笔记栏：打开即建档（已存在原样返回），嵌入 FilePreviewEditor =====
  const [note, setNote] = useState<PaperNoteDto | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  /** 笔记栏内相对链接点开的文件（null = 显示本篇笔记）；「← 回笔记」退回 */
  const [noteViewPath, setNoteViewPath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNote(null);
    setNoteError(null);
    setNoteViewPath(null);
    invoke<PaperNoteDto>("ensure_paper_note", { projectRoot, pdfPath })
      .then((dto) => {
        if (!cancelled) setNote(dto);
      })
      .catch((e) => {
        if (!cancelled) setNoteError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot, pdfPath]);

  // ===== 批次 B3：工具页签（译/生词本/大纲）、快捷 chips、护眼、toast =====

  /** Agent 栏页签：对话（默认）| 工具（划词翻译/段落对照触发时自动切工具并展开「译」段） */
  const [agentTab, setAgentTab] = useState<"chat" | "tools">("chat");
  const [toolsExpandNonce, setToolsExpandNonce] = useState(0);
  /** 本次会话译段（新→旧；组件态不落库，上限 50 条） */
  const [translations, setTranslations] = useState<ReaderTranslation[]>([]);
  const [translatingCount, setTranslatingCount] = useState(0);
  const translateIdRef = useRef(0);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [outline, setOutline] = useState<ReaderOutlineItem[] | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [jumpReq, setJumpReq] = useState<{ page: number; nonce: number } | null>(null);
  /** 护眼反色（按文件记忆；只反 PDF canvas 层，文字层保持主题色） */
  const [readerDark, setReaderDark] = useState(() => loadReaderDark(pdfPath));

  /** 轻量 toast（保存译段/生词本结果；右下角浮出 2.5s 淡出，GitPanel 同款节奏） */
  const [toast, setToast] = useState<{ text: string; ok: boolean; hiding: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(text: string, ok = true) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, ok, hiding: false });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2500);
  }
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // 换文献：会话态（译段历史/大纲/当前页）与护眼记忆按文件重置
  useEffect(() => {
    setTranslations([]);
    setTranslatingCount(0);
    setOutline(null);
    setCurrentPage(1);
    setJumpReq(null);
    setAgentTab("chat");
    setReaderDark(loadReaderDark(pdfPath));
  }, [pdfPath]);

  function toggleDark() {
    setReaderDark((v) => {
      saveReaderDark(pdfPath, !v);
      return !v;
    });
  }

  // 生词本：阅读区打开时加载一次（高亮 + 工具页签表格同源），增删后随返回值刷新
  useEffect(() => {
    let cancelled = false;
    invoke<GlossaryEntry[]>("list_glossary", { projectRoot })
      .then((list) => {
        if (!cancelled) setGlossary(list);
      })
      .catch(() => {
        /* 生词本读取失败不打断阅读：高亮与工具页签退化为空表 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  /** 翻译统一入口（ai_prompt fnKey="translate"）：word 通道不进译段历史、不切页签 */
  const requestTranslate = useCallback(
    async (
      text: string,
      page: number,
      kind: ReaderTranslateKind,
    ): Promise<ReaderTranslateResult> => {
      if (needsProfile) return { ok: false, error: "还没有可用的 API 配置" };
      const isWord = kind === "word";
      if (!isWord) {
        setAgentTab("tools");
        setToolsExpandNonce((n) => n + 1);
        setTranslatingCount((c) => c + 1);
      }
      try {
        const zh = await invoke<string>("ai_prompt", {
          profileId: null,
          fnKey: "translate",
          prompt: buildReaderTranslatePrompt(text),
        });
        const translated = zh.trim();
        if (!isWord) {
          const id = ++translateIdRef.current;
          setTranslations((prev) =>
            [
              { id, kind: kind as "selection" | "paragraph", page, original: text, translated },
              ...prev,
            ].slice(0, 50),
          );
        }
        return { ok: true, text: translated };
      } catch (e) {
        return { ok: false, error: String(e) };
      } finally {
        if (!isWord) setTranslatingCount((c) => c - 1);
      }
    },
    [needsProfile],
  );

  /** 保存译段到笔记「## 译段」（笔记栏 watcher 自动刷新）；成功后在列表里标 ✓ */
  const saveTranslation = useCallback(
    async (t: {
      id?: number;
      original: string;
      translated: string;
      page: number;
    }): Promise<string | null> => {
      if (!note) return "笔记还没建好，稍等片刻再试";
      try {
        await invoke("append_note_translation", {
          projectRoot,
          notePath: note.path,
          original: t.original,
          translated: t.translated,
          page: t.page,
        });
        showToast("已存到笔记「译段」");
        // 标 ✓ 防重：工具页签按 id；PDF 浮卡没 id，按内容同值匹配（同一译段两入口不重复追加）
        setTranslations((prev) =>
          prev.map((x) =>
            !x.saved &&
            (x.id === t.id ||
              (x.original === t.original &&
                x.translated === t.translated &&
                x.page === t.page))
              ? { ...x, saved: true }
              : x,
          ),
        );
        return null;
      } catch (e) {
        const msg = `译段保存失败：${String(e)}`;
        showToast(msg, false);
        return msg;
      }
    },
    [note, projectRoot],
  );

  const addGlossary = useCallback(
    async (
      term: string,
      meaning: string,
      source: string,
    ): Promise<string | null> => {
      try {
        const list = await invoke<GlossaryEntry[]>("append_glossary", {
          projectRoot,
          term,
          meaning,
          source,
        });
        setGlossary(list);
        showToast("已加入生词本");
        return null;
      } catch (e) {
        return `写入生词本失败：${String(e)}`;
      }
    },
    [projectRoot],
  );

  const removeGlossary = useCallback(
    async (term: string) => {
      try {
        const list = await invoke<GlossaryEntry[]>("remove_glossary_entry", {
          projectRoot,
          term,
        });
        setGlossary(list);
      } catch (e) {
        showToast(`删除生词失败：${String(e)}`, false);
      }
    },
    [projectRoot],
  );

  const handleOutlineLoad = useCallback(
    (items: ReaderOutlineItem[]) => setOutline(items),
    [],
  );
  const handlePageChange = useCallback((n: number) => setCurrentPage(n), []);
  const jumpToPage = useCallback(
    (page: number) => setJumpReq({ page, nonce: Date.now() }),
    [],
  );
  const removeTranslation = useCallback(
    (id: number) => setTranslations((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  /** chips：无阅读会话运行中时禁用（HoverTip 说明），否则写 PTY 直接发送 */
  const chipsDisabledReason = needsProfile
    ? "还没有可用的 API 配置"
    : !hasAgentTab
      ? "阅读会话未在运行"
      : null;
  const pdfRel = relToProjectRoot(projectRoot, pdfPath);
  function runChip(prompt: string) {
    const err = onInject(prompt, true);
    if (err) showToast(err, false);
  }

  // ===== Agent 栏：输入框 + 选段注入 + 会话跟随滚动 =====
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [injectError, setInjectError] = useState<string | null>(null);

  function submitInput() {
    const text = input.trim();
    if (!text) return;
    const err = onInject(text, true);
    if (err) {
      setInjectError(err);
      return;
    }
    setInjectError(null);
    setInput("");
  }

  /** PDF 选段「◈ 问 AI」：默认写进本栏输入框（人检查后再发）；↵ 直接发送走 PTY */
  const askAiFromPdf = useCallback(
    (text: string, page: number, fileName: string, send?: boolean) => {
      const data = formatPdfExcerptPrompt(text, page, fileName);
      if (send) return onInject(data, true);
      setInput((prev) => (prev.trim() ? `${prev}\n\n${data}` : data));
      inputRef.current?.focus();
      return null;
    },
    [onInject],
  );

  // ===== 圈选截图去向（批次 B2）：裁好的 PNG 由 PdfContinuousView 交来 =====

  /** ◈ 发给 agent：落剪贴板临时图（终端粘贴图片同一命令/口径）→ 路径 + 预填 prompt 写进输入框，不自动发送 */
  const captureToAgent = useCallback(
    async (blob: Blob, page: number, fileName: string): Promise<string | null> => {
      if (needsProfile) return "还没有可用的 API 配置";
      if (!hasAgentTab) return "阅读会话未在运行";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const absPath = await invoke<string>("save_clipboard_image", {
          bytes: Array.from(bytes),
          ext: "png",
        });
        const data = formatReaderCapturePrompt(absPath, page, fileName);
        setInput((prev) => (prev.trim() ? `${prev}\n\n${data}` : data));
        inputRef.current?.focus();
        return null;
      } catch (e) {
        return `截图发送准备失败：${String(e)}`;
      }
    },
    [needsProfile, hasAgentTab],
  );

  /** ＋ 插入笔记：落 notes/assets/ → 追加进「## 我的想法」；笔记栏经 watcher 自动刷新可见 */
  const captureToNote = useCallback(
    async (blob: Blob): Promise<string | null> => {
      if (!note) return "笔记还没建好，稍等片刻再试";
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const cap = await invoke<{ relPath: string; absPath: string }>(
          "save_reader_capture",
          { projectRoot, imageBase64: bytesToBase64(bytes) },
        );
        await invoke("append_note_image", {
          projectRoot,
          notePath: note.path,
          relImagePath: cap.relPath,
        });
        return null;
      } catch (e) {
        return `贴进笔记失败：${String(e)}`;
      }
    },
    [note, projectRoot],
  );

  const conv = agentSession?.conv;
  const convScrollRef = useRef<HTMLDivElement>(null);
  const convFollowRef = useRef(true);
  const [convHasNew, setConvHasNew] = useState(false);
  function scrollConvToBottom() {
    const el = convScrollRef.current;
    if (!el) return;
    convFollowRef.current = true;
    setConvHasNew(false);
    el.scrollTop = el.scrollHeight;
  }
  function onConvScroll() {
    const el = convScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
    convFollowRef.current = nearBottom;
    if (nearBottom) setConvHasNew(false);
  }
  // 新消息到达：贴底跟随；用户翻上去时只亮「有新消息 ↓」不打断阅读
  useEffect(() => {
    if (convFollowRef.current)
      requestAnimationFrame(() => {
        const el = convScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    else setConvHasNew(true);
  }, [conv]);
  // 换会话/刚关联上时重新贴底
  useEffect(() => {
    convFollowRef.current = true;
    setConvHasNew(false);
    requestAnimationFrame(() => {
      const el = convScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [agentSession?.sessionId]);

  // ===== 顶栏 tooltip（应用内 HoverTip，禁原生 title） =====
  const backRef = useRef<HTMLButtonElement>(null);
  const backTip = useHoverTip(backRef);
  const leftRef = useRef<HTMLButtonElement>(null);
  const leftTip = useHoverTip(leftRef);
  const rightRef = useRef<HTMLButtonElement>(null);
  const rightTip = useHoverTip(rightRef);
  const darkRef = useRef<HTMLButtonElement>(null);
  const darkTip = useHoverTip(darkRef);
  const gestureRef = useRef<HTMLSpanElement>(null);
  const gestureTip = useHoverTip(gestureRef);

  // ===== Agent 栏顶部状态行：agent 名 · 模型 · 启动中/运行中状态点（终端页同语义） =====
  const agentName = agentStatus
    ? (AGENTS.find((a) => a.id === agentStatus.agentId)?.label ??
      agentStatus.agentId)
    : null;
  const agentModel = agentStatus?.model?.trim();
  const agentRunning = agentStatus?.running ?? false;
  const agentStateText = agentRunning
    ? "运行中"
    : agentStatus?.startedAt
      ? "未在运行"
      : "启动中…";

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-canvas">
      {/* 40px 顶栏：← 返回（Esc 同效）/ 《文献标题》/ 收起左右栏 */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <button
          ref={backRef}
          type="button"
          onMouseEnter={backTip.show}
          onMouseLeave={backTip.hide}
          onClick={onClose}
          className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
        >
          ← 返回
        </button>
        <span className="min-w-0 flex-1 truncate px-2 text-center text-sm text-l1">
          《{stem}》
        </span>
        <button
          ref={darkRef}
          type="button"
          onMouseEnter={darkTip.show}
          onMouseLeave={darkTip.hide}
          onClick={toggleDark}
          className={`${topBtn} ${readerDark ? "bg-seg-sel text-l1" : ""}`}
        >
          ◐
        </button>
        <span
          ref={gestureRef}
          onMouseEnter={gestureTip.show}
          onMouseLeave={gestureTip.hide}
          className="flex h-7 w-7 shrink-0 cursor-help items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l2"
        >
          ?
        </span>
        <button
          ref={leftRef}
          type="button"
          onMouseEnter={leftTip.show}
          onMouseLeave={leftTip.hide}
          onClick={() => setLeftOpen((v) => !v)}
          className={topBtn}
        >
          {leftOpen ? "‹" : "›"}
        </button>
        <button
          ref={rightRef}
          type="button"
          onMouseEnter={rightTip.show}
          onMouseLeave={rightTip.hide}
          onClick={() => setRightOpen((v) => !v)}
          className={topBtn}
        >
          {rightOpen ? "›" : "‹"}
        </button>
        <HoverTip tip={backTip.tip} text="退出沉浸阅读（Esc）" />
        <HoverTip
          tip={darkTip.tip}
          text={readerDark ? "关闭护眼反色" : "护眼反色（按文件记忆）"}
        />
        <HoverTip
          tip={gestureTip.tip}
          text="⌘/Ctrl + 点击正文段落：整段对照翻译"
        />
        <HoverTip
          tip={leftTip.tip}
          text={leftOpen ? "收起笔记栏" : "展开笔记栏"}
        />
        <HoverTip
          tip={rightTip.tip}
          text={rightOpen ? "收起对话栏" : "展开对话栏"}
        />
      </div>

      {/* 三栏区：笔记 | PDF | Agent 对话（侧栏可整栏收起，拖拽条记百分比） */}
      <div ref={areaRef} className="flex min-h-0 flex-1">
        {showLeft && (
          <>
            <div
              style={{ width: leftPx || undefined }}
              className="flex min-w-0 shrink-0 flex-col border-r border-hairline bg-rail2"
            >
              {noteError ? (
                <div className="p-3">
                  <p className="text-xs text-err-text">
                    笔记建档失败：{noteError}
                  </p>
                </div>
              ) : !note ? (
                <div className="p-3">
                  <LoadingRows compact />
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="p-3">
                      <LoadingRows compact />
                    </div>
                  }
                >
                  {/* 文件名/阅读⇄编辑切换沿用 FilePreviewEditor 自带工具条（不重复画一行）；
                      hideImmersive：它自己的 ⛶ 沉浸层是 z-30，压在阅读区 z-40 下面会失灵；
                      onOpenFile：md 相对链接在笔记栏原地打开（previewReq 会开在阅读区底下看不见） */}
                  {noteViewPath && noteViewPath !== note.path && (
                    <div className="flex h-7 shrink-0 items-center border-b border-hairline px-2">
                      <button
                        type="button"
                        onClick={() => setNoteViewPath(null)}
                        className="rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                      >
                        ← 回笔记
                      </button>
                    </div>
                  )}
                  <FilePreviewEditor
                    path={noteViewPath ?? note.path}
                    root={projectRoot}
                    hideImmersive
                    onOpenFile={setNoteViewPath}
                  />
                </Suspense>
              )}
            </div>
            {splitter("left")}
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="p-3">
                <LoadingRows compact />
              </div>
            }
          >
            <PdfContinuousView
              path={pdfPath}
              cwdHint={projectRoot}
              onAskAi={askAiFromPdf}
              onBack={onClose}
              onCaptureAgent={captureToAgent}
              onCaptureNote={captureToNote}
              glossTerms={glossary}
              dark={readerDark}
              onPageChange={handlePageChange}
              onOutlineLoad={handleOutlineLoad}
              jumpToPage={jumpReq}
              onRequestTranslate={requestTranslate}
              onSaveTranslation={saveTranslation}
              onAddGlossary={addGlossary}
            />
          </Suspense>
        </div>

        {showRight && (
          <>
            {splitter("right")}
            <div
              style={{ width: rightPx || undefined }}
              className="flex min-w-0 shrink-0 flex-col border-l border-hairline bg-raised"
            >
              {/* 页签行：◔ 对话 | ✦ 工具（对话页签右侧带会话状态小字，终端页同语义） */}
              <div className="flex h-8 shrink-0 items-center border-b border-hairline px-2">
                <SegTabs
                  items={[
                    { id: "chat", label: "◔ 对话" },
                    { id: "tools", label: "✦ 工具" },
                  ]}
                  value={agentTab}
                  onChange={setAgentTab}
                />
                {agentTab === "chat" && !needsProfile && (
                  <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2 text-micro text-l4">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        agentRunning
                          ? "bg-ok-text"
                          : agentSession?.state === "timeout"
                            ? "bg-warn-text"
                            : "bg-l4"
                      }`}
                    />
                    <span className="min-w-0 truncate">
                      {`${agentName ?? "Agent"}${agentModel ? ` · ${agentModel}` : ""} · ${agentStateText}`}
                    </span>
                  </span>
                )}
              </div>
              {agentTab === "tools" ? (
                // 工具页签：译（对照卡+历史）/ 生词本 / 大纲 三段折叠；不依赖会话在跑（译段除外，失败行内报错）
                <ReaderToolsPanel
                  translations={translations}
                  translating={translatingCount > 0}
                  glossary={glossary}
                  outline={outline}
                  expandNonce={toolsExpandNonce}
                  onSaveTranslation={saveTranslation}
                  onRemoveTranslation={removeTranslation}
                  onRemoveGlossary={(term) => void removeGlossary(term)}
                  onJumpPage={jumpToPage}
                />
              ) : needsProfile ? (
                // 无可用配置：引导卡（一句话 + 跳配置页）
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
                  <p className="text-sm text-l3">还没有可用的 API 配置</p>
                  <button
                    type="button"
                    onClick={onGoProfiles}
                    className="rounded-md border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110"
                  >
                    去配置页添加
                  </button>
                </div>
              ) : !hasAgentTab ? (
                // 阅读会话标签被手动关掉：给个重新拉起的入口（不连环自动重建）
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
                  <p className="text-sm text-l3">阅读会话未在运行</p>
                  <button
                    type="button"
                    onClick={onRestartAgent}
                    className="rounded-md border border-field bg-strip px-3 py-1.5 text-sm text-l2 hover:bg-inset hover:text-l1"
                  >
                    重新启动会话
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative min-h-0 flex-1">
                    <div
                      ref={convScrollRef}
                      onScroll={onConvScroll}
                      className="h-full overflow-auto p-3"
                    >
                      {!agentSession || agentSession.state === "idle" ? (
                        <p className="text-sm text-l4">
                          启动 Agent 后将在这里同步当前对话
                        </p>
                      ) : agentSession.state === "detecting" ? (
                        <p className="text-sm text-l4">正在识别当前对话…</p>
                      ) : agentSession.state === "timeout" &&
                        !agentSession.file ? (
                        <p className="text-sm text-l4">
                          暂未识别到对话，后台仍会自动重试
                        </p>
                      ) : agentSession.conv.length === 0 ? (
                        <p className="text-sm text-l4">等待第一条对话…</p>
                      ) : (
                        <ConversationView messages={agentSession.conv} compact />
                      )}
                    </div>
                    {convHasNew && (
                      <button
                        type="button"
                        onClick={scrollConvToBottom}
                        className="absolute bottom-3 right-3 rounded-sm border border-field bg-strip px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                      >
                        有新消息 ↓
                      </button>
                    )}
                  </div>
                  {/* 底部真实输入框：Enter 发送（pty_write 补 \r），Shift+Enter 换行；
                      选段问 AI / 后续截图注入都写进这里 */}
                  <div className="shrink-0 border-t border-hairline p-2">
                    {/* 快捷 chips：三条预填 prompt 直接发送；会话没在跑时禁用并 HoverTip 说明 */}
                    <div className="mb-1.5 flex items-center gap-1">
                      <ReaderChip
                        label="◈ 图导游"
                        disabledReason={chipsDisabledReason}
                        onClick={() => runChip(buildFigureTourPrompt(pdfRel))}
                      />
                      <ReaderChip
                        label="◈ 总结这页"
                        disabledReason={chipsDisabledReason}
                        onClick={() =>
                          runChip(buildPageSummaryPrompt(pdfRel, currentPage))
                        }
                      />
                      <ReaderChip
                        label="◈ 帮我改笔记"
                        disabledReason={
                          chipsDisabledReason ?? (note ? null : "笔记还没建好")
                        }
                        onClick={() => {
                          if (note) {
                            runChip(
                              buildNotePolishPrompt(
                                relToProjectRoot(projectRoot, note.path),
                              ),
                            );
                          }
                        }}
                      />
                    </div>
                    {injectError && (
                      <p className="mb-1 text-micro text-err-text">
                        {injectError}
                      </p>
                    )}
                    <textarea
                      ref={inputRef}
                      value={input}
                      rows={3}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          submitInput();
                        }
                      }}
                      placeholder="向 Agent 提问（Enter 发送）"
                      className="w-full resize-none rounded-md border border-field bg-inset px-2.5 py-2 text-xs text-l1 outline-none placeholder:text-l4 focus:border-l4"
                    />
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* 保存译段/生词本结果 toast：右下角浮出 2.5s 淡出（✓/✗ 语义色小标） */}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-hairline ccode-float-surface px-3 py-2 text-sm text-l1 transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span className={toast.ok ? "text-ok-text" : "text-err-text"}>
            {toast.ok ? "✓" : "✗"}
          </span>
          <span>{toast.text}</span>
        </div>
      )}
    </div>
  );
}

/** 对话页签输入框上方的快捷 chip（行内小胶囊 ghost 样式）：
 *  禁用时不注册 hover 也能看原因——事件挂包裹 span（HoverTip 禁用悬浮口径） */
function ReaderChip({
  label,
  disabledReason,
  onClick,
}: {
  label: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(ref);
  return (
    <span
      ref={ref}
      onMouseEnter={disabledReason ? show : undefined}
      onMouseLeave={hide}
      className="inline-flex"
    >
      <button
        type="button"
        disabled={disabledReason !== null}
        onClick={onClick}
        className="h-7 rounded-full px-2.5 text-micro text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
      >
        {label}
      </button>
      {disabledReason && <HoverTip tip={tip} text={disabledReason} />}
    </span>
  );
}
