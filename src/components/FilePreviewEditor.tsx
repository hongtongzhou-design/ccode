import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { marked } from "marked";
import SelectionFloatBar from "./SelectionFloatBar";

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

/** 按文件扩展名/文件名推断 Monaco 语言（无匹配则 plaintext） */
function languageFor(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.includes(name)) return lang.id;
    if (ext && lang.extensions?.includes(ext)) return lang.id;
  }
  return undefined;
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
 * 点击把选段 + 出处交给调用方写入活跃终端输入（不自动发送）；沉浸阅读覆盖层同款生效。
 */
function MarkdownView({
  text,
  large,
  fileName,
  onDiscuss,
}: {
  text: string;
  large?: boolean;
  fileName: string;
  /** 返回 null 表示已写入；返回字符串为要给用户看的提示（如无运行中 agent） */
  onDiscuss?: (text: string, fileName: string) => string | null;
}) {
  const html = useMemo(
    // ⚠️（U+26A0+U+FE0F）在 WKWebView 里渲染成黄色 Apple Color Emoji，
    // 与沉浸冷黑主题冲突（笔记里大量「⚠️ 仅摘要」提示）；换成文本呈现选择符
    // FE0E 让其按文字颜色单色渲染。只改显示、不改文件内容；
    // 实测 font-variant-emoji: text 在 WKWebView 无效，故走字符替换
    () =>
      marked.parse(text.replace(/\u26A0\uFE0F/g, "\u26A0\uFE0E"), {
        gfm: true,
        breaks: false,
        async: false,
      }),
    [text],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
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

  /** 选段 → 活跃终端 agent 输入（不自动发送）；成功写入后清选区，浮动条随 selectionchange 收起 */
  function discuss() {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected || !onDiscuss) return;
    const err = onDiscuss(selected, fileName);
    showHint(err ?? "已写入活跃终端的输入框，接着输入你的意见后自行发送");
    if (!err) window.getSelection()?.removeAllRanges();
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
          className={`md-body${large ? " md-body-lg" : ""} ${
            large ? "mx-auto max-w-3xl px-8 py-10" : "px-5 py-4"
          }`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {onDiscuss && (
          <SelectionFloatBar
            containerRef={scrollRef}
            withinSelector=".md-body"
            reserveWidth={150}
          >
            <button
              type="button"
              // preventDefault 保住选区，click 时才读文字
              onMouseDown={(e) => e.preventDefault()}
              onClick={discuss}
              className="rounded border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110"
            >
              ◈ 讨论/改写此段
            </button>
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
 */
function FilePreviewEditor({
  path,
  root,
  onDirtyChange,
  onDiscuss,
}: {
  path: string;
  root: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** md 阅读视图选段「◈ 讨论/改写此段」：写入活跃终端输入；返回 null 已写入，否则为提示 */
  onDiscuss?: (text: string, fileName: string) => string | null;
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
  // 阅读/编辑模式与沉浸覆盖层（仅 md 有阅读态；其他文本固定编辑态）
  const isMd = isMarkdownPath(path);
  const [mode, setMode] = useState<"read" | "edit">(isMd ? "read" : "edit");
  const [immersive, setImmersive] = useState(false);

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
      !window.confirm(
        "这是主仓库（非工作区分支）的文件，保存会直接改动主项目。确认保存？",
      )
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
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
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
          <span className="shrink-0 rounded bg-warn px-1 text-warn-text">
            已截断（只读）
          </span>
        )}
        {dirty && <span className="shrink-0 text-l3" title="有未保存的修改">●</span>}
        {isMd && (
          <div className="flex shrink-0 items-center rounded bg-inset p-0.5 text-[11px]">
            {(["read", "edit"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-0.5 ${
                  mode === m ? "bg-seg-sel text-l1" : "text-l3 hover:text-l2"
                }`}
              >
                {m === "read" ? "阅读" : "编辑"}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {ready && (mode === "edit" || isMd) && (
            <button
              onClick={() => setImmersive(true)}
              title={`全宽沉浸${mode === "read" ? "阅读" : "编辑"}（Esc 退出）`}
              className="shrink-0 rounded px-2 py-0.5 text-l2 hover:bg-white/5"
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
              className={`shrink-0 rounded px-2 py-0.5 hover:bg-white/5 disabled:opacity-50 ${
                ctx?.kind === "main" ? "text-warn-text" : "text-l2"
              }`}
            >
              {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
            </button>
          )}
        </div>
      </div>
      {error && <p className="px-3 py-1 text-xs text-err-text">{error}</p>}
      {mode === "read" && ready && (
        <MarkdownView
          text={text!}
          fileName={path.split(/[\\/]/).pop() ?? path}
          onDiscuss={onDiscuss}
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
                className={`ml-auto shrink-0 rounded px-2 py-1 hover:bg-white/5 disabled:opacity-50 ${
                  ctx?.kind === "main" ? "text-warn-text" : "text-l2"
                }`}
              >
                {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
              </button>
            )}
            <button
              onClick={() => setImmersive(false)}
              title={`退出沉浸${mode === "read" ? "阅读" : "编辑"}（Esc）`}
              className={`${mode === "edit" && !truncated ? "" : "ml-auto "}shrink-0 rounded px-2 py-1 text-l3 hover:bg-white/5 hover:text-l1`}
            >
              ✕ 退出
            </button>
          </div>
          {mode === "read" ? (
            <MarkdownView
              text={text ?? ""}
              large
              fileName={path.split(/[\\/]/).pop() ?? path}
              onDiscuss={onDiscuss}
            />
          ) : (
            <div ref={immersiveSlotRef} className="contents" />
          )}
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 Monaco 编辑器 */
export default memo(FilePreviewEditor);
