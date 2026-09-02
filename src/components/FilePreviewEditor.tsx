import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { marked } from "marked";
import SelectionFloatBar, { DistillSkillButton } from "./SelectionFloatBar";
import { confirmDialog } from "./ConfirmDialog";
import { useAppStore } from "../store";
import {
  bytesToBase64,
  classifyMdHref,
  relMdLinkPath,
  resolveMdPath,
  rewriteMdImageHtml,
} from "../reader";
import { escapeShellPath, imageExtFromMime } from "../terminal-input";
import { comboLabel, IS_WINDOWS, READER_MODE_HOTKEY } from "../hotkeys";
// md-math 模块作用域完成 marked 公式扩展注册（全局生效，占位=原始 $..$ 源码，未升级处观感不变）
import { renderMathInto } from "../md-math";
import { hydrateMdImages } from "../md-image-hydrate";
import { isPreviewableImagePath } from "../file-icons";
import ImagePreview from "./ImagePreview";
import {
  LATEX_EXTENSIONS,
  LATEX_LANGUAGE_ID,
  latexMonarch,
  matchLanguageByPath,
} from "../editor-languages";

// 只用基础 editor worker（不需要语言服务的 intellisense）
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// Monaco 主题跟随 App.css 令牌：编辑器面色从 --color-editor-* 三个 CSS 变量实时读取
// （与设置页 readThemeSwatch 同一思路，避免双份维护色值漂移）；base vs-dark 继承语法高亮。
// 主题切换由 MutationObserver 监听 data-theme 触发重新 define + setTheme（见组件内 effect）。
function syncMonacoTheme() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  monaco.editor.defineTheme("ccode-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": read("--color-editor-bg", "#11131a"),
      "editor.foreground": read("--color-editor-fg", "#aeb6c6"),
      "editorLineNumber.foreground": read("--color-editor-line", "#525a6b"),
    },
  });
}
syncMonacoTheme();

// LaTeX 语言注册（批次 E）：monaco 0.56 内置语言表没有 latex，注册自带 monarch 定义；
// languageFor 按已注册语言表的扩展名自动命中，无需单独映射
monaco.languages.register({
  id: LATEX_LANGUAGE_ID,
  extensions: [...LATEX_EXTENSIONS],
});
monaco.languages.setMonarchTokensProvider(LATEX_LANGUAGE_ID, latexMonarch);

/** 按文件扩展名/文件名推断 Monaco 语言（无匹配则 plaintext） */
function languageFor(path: string): string | undefined {
  return matchLanguageByPath(monaco.languages.getLanguages(), path);
}

/** 路径归属（workspaces::path_context）：防止误以为在改分支实际改了主仓库 */
interface PathContext {
  kind: "worktree" | "main" | "other";
  workspaceName: string | null;
  branch: string | null;
}

/** md 文件默认走阅读版式（RX2a 笔记阅读模式） */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Markdown 阅读视图（RX2a）：marked 渲染本地文件内容。
 * 渲染源是 read_file_preview 根约束内的用户本地文件（可信内容），
 * 因此不引入 sanitize 重库；仅关闭与本场景无关的项，GFM 支持表格等。
 * v1 代码块不做语法高亮（素色块），样式全部走 App.css 的 .md-body 主题令牌。
 * 选中文字出现浮动按钮「◈ 讨论/改写此段」（与 PDF 问 AI 共用 SelectionFloatBar），
 * 点击把选段 + 出处交给调用方写入活跃终端输入（「↵ 直接发送」立即回车发送）；沉浸阅读覆盖层同款生效。
 * 另有「✦ 沉淀为技能」（DistillSkillButton）：AI 把选段提炼成技能草稿，跳技能页新建表单预填。
 * 批次 B2 / v3.161 后处理：渲染前把 img 换成 data-md-src 占位 span（避免 WebView
 * 把相对/绝对本地 png/gif 当成网站地址拉成裂图，也避免无 src 的 img 直接画问号）；
 * 本地图经 read_image_bytes 换 data URL。本机打开的 md 允许显示 https 图；
 * 相对链接点击在阅读区笔记栏/预览页签内打开。
 */
function MarkdownView({
  text,
  large,
  fileName,
  filePath,
  root,
  onDiscuss,
  onOpenFile,
}: {
  text: string;
  large?: boolean;
  fileName: string;
  /** 当前 md 文件绝对路径：相对图片/链接的解析基准 */
  filePath: string;
  /** 预览根约束（read_image_bytes 的 cwdHint 来源之一） */
  root: string;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent）。send=true 直接发送 */
  onDiscuss?: (text: string, fileName: string, send?: boolean) => string | null;
  /** 相对链接的打开去向（阅读区笔记栏原地打开）；缺省走 store previewReq 终端页预览 */
  onOpenFile?: (absPath: string) => void;
}) {
  const html = useMemo(
    // ⚠️（U+26A0+U+FE0F）在 WKWebView 里渲染成黄色 Apple Color Emoji，
    // 与沉浸冷黑主题冲突（笔记里大量「⚠️ 仅摘要」提示）；换成文本呈现选择符
    // FE0E 让其按文字颜色单色渲染。只改显示、不改文件内容；
    // 实测 font-variant-emoji: text 在 WKWebView 无效，故走字符替换
    () =>
      rewriteMdImageHtml(
        marked.parse(text.replace(/\u26A0\uFE0F/g, "\u26A0\uFE0E"), {
          gfm: true,
          breaks: false,
          async: false,
        }) as string,
      ),
    [text],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  /** 选段 → 活跃终端 agent 输入；send=true 直接发送。成功写入后清选区，浮动条随 selectionchange 收起 */
  function discuss(send?: boolean) {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected || !onDiscuss) return;
    const err = onDiscuss(selected, fileName, send);
    showHint(
      err ??
        (send
          ? "已发送到活跃终端"
          : "已写入活跃终端的输入框，接着输入你的意见后自行发送"),
    );
    if (!err) window.getSelection()?.removeAllRanges();
  }

  // 每次 layout 都扫剩余 [data-md-src]：父级重绘若把 innerHTML 盖回占位，
  // deps 不变就不会进这个 effect，图会永远停在「图片加载中」。
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    hydrateMdImages(host, {
      fromFile: filePath,
      cwdHint: root,
      allowHttps: true,
    });
  });

  // 公式升级（批次 E）：.md-math 占位换 KaTeX 排版；无公式时函数直接返回、不加载 katex
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    void renderMathInto(host);
  }, [html]);

  /** 链接点击（批次 B2）：锚点默认滚动；外链走系统浏览器（openUrl，webview 内跳转会破坏应用）；
      相对/绝对路径原地打开——阅读区笔记栏由 onOpenFile 接管，否则 previewReq 跳终端页预览 */
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    const kind = classifyMdHref(href);
    if (kind === "anchor") return;
    e.preventDefault();
    if (kind === "external" || kind === "other") {
      void openUrl(href).catch(() => showHint("无法打开外部链接"));
      return;
    }
    const abs = resolveMdPath(filePath, href);
    if (onOpenFile) onOpenFile(abs);
    else setPreviewReq({ path: abs, name: abs.split(/[\\/]/).pop() ?? abs, root });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hint && (
        <p
          className="shrink-0 truncate bg-inset px-3 py-1 text-xs text-l2"
          title={hint}
        >
          {hint}
        </p>
      )}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          ref={bodyRef}
          onClick={onBodyClick}
          className={`md-body${large ? " md-body-lg" : ""} ${
            large ? "mx-auto max-w-3xl px-8 py-10" : "px-5 py-4"
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {onDiscuss && (
          <SelectionFloatBar
            containerRef={scrollRef}
            withinSelector=".md-body"
            reserveWidth={320}
          >
            <button
              type="button"
              // preventDefault 保住选区，click 时才读文字
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => discuss()}
              className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
            >
              ◈ 讨论/改写此段
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => discuss(true)}
              className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
            >
              ↵ 直接发送
            </button>
            <DistillSkillButton onHint={showHint} />
          </SelectionFloatBar>
        )}
      </div>
    </div>
  );
}

/**
 * 文件预览编辑器（P4）：Monaco 取代只读 pre。
 * 内容经 read_file_preview 加载（根目录约束、二进制/截断处理沿用后端），
 * 脏状态上报给调用方（预览页签的脏点），保存走 save_file_preview（原子写）。
 * png/jpg/gif/webp/svg 在入口处改走 ImagePreview，避免 NUL 嗅探报「二进制不支持」。
 */
function TextFilePreviewEditor({
  path,
  root,
  onDirtyChange,
  onDiscuss,
  hideImmersive,
  onOpenFile,
  onOpenReader,
  modeTick,
}: {
  path: string;
  root: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** md 阅读视图选段「◈ 讨论/改写此段」：写入活跃终端输入（send=true 直接发送）；返回 null 已写入，否则为提示 */
  onDiscuss?: (text: string, fileName: string, send?: boolean) => string | null;
  /** 嵌入阅读区笔记栏时置 true：自带的 ⛶ 沉浸层是 z-30，压在阅读区 z-40 下面会失灵 */
  hideImmersive?: boolean;
  /** md 阅读视图相对链接的打开去向（阅读区笔记栏原地打开）；缺省走 previewReq 终端页预览 */
  onOpenFile?: (absPath: string) => void;
  /** md 阅读态「⛶ 沉浸阅读」改为进三栏阅读区（笔记｜PDF｜Agent，配对失败由调用方提示）；
      缺省保持自带的单栏沉浸层 */
  onOpenReader?: () => void;
  /** 外部触发「阅读/编辑」翻转的信号（阅读区 ⌘E；先例：TerminalPage readerAgentTick
      同款 tick/signal 模式）——值变化即翻转，初挂载不动作；传了它才在按钮 title 上带快捷键 */
  modeTick?: number;
}) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // 编辑器宿主节点独立于 React 渲染树：沉浸编辑切换只移动 DOM 节点，
  // Monaco 实例、undo 栈、dirty 与光标全部保留（React 重挂会丢实例）
  const hostElRef = useRef<HTMLDivElement | null>(null);
  if (!hostElRef.current) hostElRef.current = document.createElement("div");
  const normalSlotRef = useRef<HTMLDivElement>(null);
  const immersiveSlotRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  /** text 对应的文件路径：路径切换后旧内容不等新加载、立即视为无效（防残留误导） */
  const textPathRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ctx, setCtx] = useState<PathContext | null>(null);
  // 粘贴图片等输入侧动作的瞬态轻反馈（3s 自动消，同终端页 inputNote 模式）
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const pasteNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashPasteNote(text: string) {
    setPasteNote(text);
    if (pasteNoteTimerRef.current) clearTimeout(pasteNoteTimerRef.current);
    pasteNoteTimerRef.current = setTimeout(() => setPasteNote(null), 3000);
  }
  useEffect(
    () => () => {
      if (pasteNoteTimerRef.current) clearTimeout(pasteNoteTimerRef.current);
    },
    [],
  );
  // 阅读/编辑模式与沉浸覆盖层（仅 md 有阅读态；其他文本固定编辑态）
  const isMd = isMarkdownPath(path);
  const [mode, setMode] = useState<"read" | "edit">(isMd ? "read" : "edit");
  const [immersive, setImmersive] = useState(false);

  /** 编辑→阅读：把编辑器缓冲（含未保存改动）同步进 text 状态。
      编辑期间 text 不随键入更新、dirty 时 watcher 也停订，不同步的话
      阅读态永远停在旧盘稿（新增/删除都看不见）；反向（text → 编辑器）
      由既有的 external-reload effect 负责，模型相同会自行跳过 */
  function switchMode(m: "read" | "edit") {
    if (m === "read" && editorRef.current) {
      setText(editorRef.current.getValue());
    }
    setMode(m);
  }

  // 外部快捷键翻转（阅读区 ⌘E）：tick 变化即翻转一次；初挂载跳过
  const modeTickRef = useRef(modeTick);
  useEffect(() => {
    if (modeTickRef.current === modeTick) return;
    modeTickRef.current = modeTick;
    if (isMd) switchMode(mode === "read" ? "edit" : "read");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeTick]);

  // 宿主节点挂到当前槽位（普通位置或沉浸覆盖层），移动不重建编辑器
  useEffect(() => {
    const host = hostElRef.current!;
    const slot =
      immersive && mode === "edit" ? immersiveSlotRef.current : normalSlotRef.current;
    slot?.appendChild(host);
    host.className = `min-h-0 flex-1${mode === "read" ? " hidden" : ""}`;
  }, [immersive, mode]);

  // 路径切换时按文件类型重置阅读/编辑与沉浸态
  useEffect(() => {
    setMode(isMarkdownPath(path) ? "read" : "edit");
    setImmersive(false);
  }, [path]);

  // 沉浸覆盖层（阅读/编辑共用）：Esc 退出（终端/PTY 保持挂载，仅视觉覆盖，同评审覆盖层形态）
  useEffect(() => {
    if (!immersive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImmersive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [immersive]);

  // 路径归属查询（失败/未命中不显示徽标）
  useEffect(() => {
    let cancelled = false;
    setCtx(null);
    invoke<PathContext>("path_context", { path })
      .then((c) => {
        if (!cancelled && c.kind !== "other") setCtx(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 磁盘上的最新内容（加载/保存时更新）：外部变化重载时用于比对，避免自己保存触发的回环
  const lastSavedRef = useRef<string | null>(null);
  // executeEdits 做外部内容替换期间置位，dirty 监听跳过这次程序性改动
  const applyingExternalRef = useRef(false);

  // 加载文件内容
  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    setDirty(false);
    onDirtyChange?.(false);
    void (async () => {
      try {
        const p = await invoke<{ text: string; truncated: boolean }>(
          "read_file_preview",
          { path, root },
        );
        if (cancelled) return;
        lastSavedRef.current = p.text;
        textPathRef.current = path;
        setText(p.text);
        setTruncated(p.truncated);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root]);

  // text 只有在属于当前 path 时才有效；切换路径的瞬间旧内容立即失效（空白等待新加载）
  const ready = text !== null && textPathRef.current === path;

  // 外部变化自动刷新（合并/agent 写盘等）：监听文件所在目录，内容真的变了才重载；
  // 编辑中（dirty）不订阅，不覆盖用户未保存的修改
  useEffect(() => {
    if (dirty || !ready) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchId: string | null = null;
    const parent = path.replace(/[\\/][^\\/]*$/, "");
    void (async () => {
      try {
        watchId = await invoke<string>("watch_dir", { path: parent });
        if (cancelled) {
          invoke("unwatch_dir", { id: watchId }).catch(() => {});
          return;
        }
        unlisten = await listen(`fs-changed-${watchId}`, async () => {
          try {
            const p = await invoke<{ text: string }>("read_file_preview", { path, root });
            if (!cancelled && p.text !== lastSavedRef.current) {
              lastSavedRef.current = p.text;
              setText(p.text);
            }
          } catch {
            /* 文件被删/不可读：保持现状 */
          }
        });
      } catch {
        /* 目录不可监听：退回手动重开 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (watchId) invoke("unwatch_dir", { id: watchId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, root, dirty, ready]);

  // 创建/销毁编辑器（截断文件只读，避免保存出不完整内容）。
  // 同路径的外部内容更新不重建编辑器，由下方同步 effect 走 executeEdits，保住滚动/光标/undo。
  useEffect(() => {
    if (!ready) return;
    syncMonacoTheme(); // 创建前对齐当前 data-theme 的编辑器面色
    const ed = monaco.editor.create(hostElRef.current!, {
      value: text!,
      language: languageFor(path),
      theme: "ccode-dark",
      readOnly: truncated,
      minimap: { enabled: false },
      fontSize: 12.5,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
      // 关闭 unicode 高亮（VS Code 式防 Trojan Source 特性）：其 locale 精确匹配
      // zh-hans 在 WKWebView 里拿不到（_os 得 zh-Hans-CN、_vscode 得 zh-cn，均不命中），
      // 回落 _default 后全角标点（）：；， 全部被套黄色方框；即使命中，
      // 科研笔记里大量出现的 −（U+2212）×（U+00D7）也照框不误——对中文笔记纯噪音
      unicodeHighlight: {
        ambiguousCharacters: false,
        invisibleCharacters: false,
        nonBasicASCII: false,
      },
    });
    editorRef.current = ed;
    const sub = ed.onDidChangeModelContent(() => {
      if (applyingExternalRef.current) return;
      setDirty(true);
      onDirtyChange?.(true);
    });
    return () => {
      sub.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, truncated]);

  // 编辑态粘贴图片（批次 B2）：剪贴板含 image/* 时接管粘贴——
  // 项目内 md 落 notes/assets/ 并在光标处插 ![](相对路径)；非项目文件回落临时图路径文本（终端粘贴同口径）
  useEffect(() => {
    const ed = editorRef.current;
    const dom = ed?.getDomNode();
    if (!ed || !dom || !isMd || truncated) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const item = Array.from(items).find((it) => it.type.startsWith("image/"));
      if (!item) return; // 纯文本粘贴走 Monaco 默认
      e.preventDefault();
      e.stopPropagation();
      const file = item.getAsFile();
      if (file) void pasteImageIntoMd(ed, file);
    };
    dom.addEventListener("paste", onPaste, true);
    return () => dom.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, truncated, isMd, path, root]);

  /** 粘贴图片落盘并在光标处插入（executeEdits 会触发 dirty，沿用既有保存链路） */
  async function pasteImageIntoMd(
    ed: monaco.editor.IStandaloneCodeEditor,
    file: File,
  ) {
    flashPasteNote("正在保存图片…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let insert: string;
      try {
        const cap = await invoke<{ relPath: string; absPath: string }>(
          "save_reader_capture",
          { projectRoot: root, imageBase64: bytesToBase64(bytes) },
        );
        insert = `![](${relMdLinkPath(path, cap.absPath)})`;
      } catch (reason) {
        // 不在已注册项目内：回落 <config>/ccode/tmp 临时图 + 路径文本；其它失败如实上报
        if (!String(reason).includes("不是 Ccode 项目")) throw reason;
        const p = await invoke<string>("save_clipboard_image", {
          bytes: Array.from(bytes),
          ext: imageExtFromMime(file.type),
        });
        insert = escapeShellPath(p, IS_WINDOWS);
      }
      const sel = ed.getSelection();
      if (!sel) return;
      ed.executeEdits("paste-image", [{ range: sel, text: insert }]);
      ed.pushUndoStop();
      ed.focus();
      flashPasteNote("已插入图片");
    } catch (e) {
      flashPasteNote(`粘贴图片失败：${String(e)}`);
    }
  }

  // 主题切换跟随：data-theme 变化时按最新 CSS 变量重定义并应用（setTheme 全局生效，
  // 同时覆盖其他已挂载的编辑器实例；设置页色卡预览的瞬时翻转也只是多余一次重定义）
  useEffect(() => {
    const obs = new MutationObserver(() => {
      syncMonacoTheme();
      monaco.editor.setTheme("ccode-dark");
    });
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);

  // 外部变化重载（合并/agent 写盘等）：整文替换但保留视图状态与 undo 栈。
  // 仅在非 dirty 时外部内容才会进来（上方监听 effect 的订阅条件），不会覆盖用户编辑
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || text === null) return;
    const model = ed.getModel();
    if (!model || model.getValue() === text) return;
    applyingExternalRef.current = true;
    ed.executeEdits("external-reload", [{ range: model.getFullModelRange(), text }]);
    applyingExternalRef.current = false;
  }, [text]);

  async function onSave() {
    const ed = editorRef.current;
    if (!ed) return;
    // 主仓库文件保存前必须确认：改动不属于任何分支，直接写主项目（防误改）
    if (
      ctx?.kind === "main" &&
      !(await confirmDialog(
        "这是主仓库（非工作区分支）的文件，保存会直接改动主项目。确认保存？",
        { danger: true },
      ))
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_file_preview", { path, root, text: ed.getValue() });
      lastSavedRef.current = ed.getValue(); // 自己保存的也算磁盘最新，防监听回环
      setDirty(false);
      onDirtyChange?.(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条：h-8 + 底部 hairline 与阅读区三栏的顶条规格统一（栏间严丝合缝） */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 text-xs">
        <span className="truncate text-l3">{path.split(/[\\/]/).pop()}</span>
        {ctx?.kind === "worktree" && (
          <span
            className="flex shrink-0 items-center gap-1 text-l3"
            title={`该文件在工作区「${ctx.workspaceName}」的工作树里，改动属于分支 ${ctx.branch}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ok-text" />
            分支 {ctx.branch}
          </span>
        )}
        {ctx?.kind === "main" && (
          <span
            className="flex shrink-0 items-center gap-1 text-warn-text"
            title={`该文件在主仓库（${ctx.branch}）里，改动不属于任何工作区分支——要改分支请从工作区进入`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn-text" />
            主仓库（非分支）
          </span>
        )}
        {truncated && (
          <span className="shrink-0 rounded-sm bg-warn px-1 text-warn-text">
            已截断（只读）
          </span>
        )}
        {dirty && <span className="shrink-0 text-l3" title="有未保存的修改">●</span>}
        {isMd && (
          <div className="flex shrink-0 items-center rounded-sm bg-inset p-0.5 text-micro">
            {(["read", "edit"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                // 快捷键只有外部接线（modeTick，阅读区 ⌘E）时才在 title 上承诺
                title={
                  modeTick !== undefined
                    ? `${m === "read" ? "阅读" : "编辑"}（${comboLabel(READER_MODE_HOTKEY)} 切换）`
                    : undefined
                }
                className={`rounded-sm px-2 py-0.5 ${
                  mode === m ? "bg-seg-sel text-l1" : "text-l3 hover:text-l2"
                }`}
              >
                {m === "read" ? "阅读" : "编辑"}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {ready && !hideImmersive && (mode === "edit" || isMd) && (
            <button
              onClick={() =>
                isMd && mode === "read" && onOpenReader
                  ? onOpenReader()
                  : setImmersive(true)
              }
              title={
                isMd && mode === "read" && onOpenReader
                  ? "进沉浸阅读区（笔记｜PDF｜Agent 三栏，自动配对本篇 PDF）"
                  : `全宽沉浸${mode === "read" ? "阅读" : "编辑"}（Esc 退出）`
              }
              className="shrink-0 rounded-sm px-2 py-0.5 text-l2 hover:bg-hover"
            >
              ⛶ {mode === "read" ? "沉浸阅读" : "沉浸编辑"}
            </button>
          )}
          {!truncated && mode === "edit" && (
            <button
              onClick={onSave}
              disabled={!dirty || saving}
              title={
                ctx?.kind === "main"
                  ? "直接修改主项目（不属于任何分支），保存前会再确认"
                  : undefined
              }
              className={`shrink-0 rounded-sm px-2 py-0.5 hover:bg-hover disabled:opacity-50 ${
                ctx?.kind === "main" ? "text-warn-text" : "text-l2"
              }`}
            >
              {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="px-3 py-1 text-xs text-err-text">{error}</p>}
      {pasteNote && <p className="px-3 py-1 text-xs text-l3">{pasteNote}</p>}
      {mode === "read" && ready && (
        <MarkdownView
          text={text!}
          fileName={path.split(/[\\/]/).pop() ?? path}
          filePath={path}
          root={root}
          onDiscuss={onDiscuss}
          onOpenFile={onOpenFile}
        />
      )}
      {/* Monaco 宿主槽位（display:contents 不改变布局）：编辑器 DOM 节点由 effect 挂入，
          阅读态仅隐藏、沉浸编辑时移到覆盖层槽位——未保存改动/光标/undo 全程不丢，
          外部刷新与 dirty 语义沿用现有 watcher 链路不变 */}
      <div ref={normalSlotRef} className="contents" />
      {immersive && (
        <div className="fixed inset-0 z-30 flex min-h-0 flex-col bg-canvas">
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-strip px-3 py-2 text-xs">
            <span className="truncate text-sm text-l1">
              {path.split(/[\\/]/).pop()}
            </span>
            <span className="text-l4">
              沉浸{mode === "read" ? "阅读" : "编辑"} · Esc 退出
            </span>
            {mode === "edit" && !truncated && (
              <button
                onClick={onSave}
                disabled={!dirty || saving}
                title={
                  ctx?.kind === "main"
                    ? "直接修改主项目（不属于任何分支），保存前会再确认"
                    : undefined
                }
                className={`ml-auto shrink-0 rounded-sm px-2 py-1 hover:bg-hover disabled:opacity-50 ${
                  ctx?.kind === "main" ? "text-warn-text" : "text-l2"
                }`}
              >
                {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
              </button>
            )}
            <button
              onClick={() => setImmersive(false)}
              title={`退出沉浸${mode === "read" ? "阅读" : "编辑"}（Esc）`}
              className={`${mode === "edit" && !truncated ? "" : "ml-auto "}shrink-0 rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1`}
            >
              ✕ 退出
            </button>
          </div>
          {mode === "read" ? (
            <MarkdownView
              text={text ?? ""}
              large
              fileName={path.split(/[\\/]/).pop() ?? path}
              filePath={path}
              root={root}
              onDiscuss={onDiscuss}
              onOpenFile={onOpenFile}
            />
          ) : (
            <div ref={immersiveSlotRef} className="contents" />
          )}
        </div>
      )}
    </div>
  );
}

function FilePreviewEditor(
  props: ComponentProps<typeof TextFilePreviewEditor>,
) {
  if (isPreviewableImagePath(props.path)) {
    return <ImagePreview path={props.path} cwdHint={props.root} />;
  }
  return <TextFilePreviewEditor {...props} />;
}

/** memo：父级重渲染不级联到 Monaco 编辑器 */
export default memo(FilePreviewEditor);
