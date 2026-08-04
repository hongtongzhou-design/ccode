import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

// 只用基础 editor worker（不需要语言服务的 intellisense）
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// 与沉浸冷黑主题一致的 monaco 主题（定义一次；base vs-dark 继承语法高亮配色）
monaco.editor.defineTheme("ccode-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#11131a",
    "editor.foreground": "#aeb6c6",
    "editorLineNumber.foreground": "#525a6b",
  },
});

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

/**
 * 文件预览编辑器（P4）：Monaco 取代只读 pre。
 * 内容经 read_file_preview 加载（根目录约束、二进制/截断处理沿用后端），
 * 脏状态上报给调用方（预览页签的脏点），保存走 save_file_preview（原子写）。
 */
function FilePreviewEditor({
  path,
  root,
  onDirtyChange,
}: {
  path: string;
  root: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [text, setText] = useState<string | null>(null);
  /** text 对应的文件路径：路径切换后旧内容不等新加载、立即视为无效（防残留误导） */
  const textPathRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ctx, setCtx] = useState<PathContext | null>(null);

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
    if (!ready || !hostRef.current) return;
    const ed = monaco.editor.create(hostRef.current, {
      value: text!,
      language: languageFor(path),
      theme: "ccode-dark",
      readOnly: truncated,
      minimap: { enabled: false },
      fontSize: 12.5,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
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
            <span className="h-1.5 w-1.5 rounded-full bg-okb" />
            分支 {ctx.branch}
          </span>
        )}
        {ctx?.kind === "main" && (
          <span
            className="flex shrink-0 items-center gap-1 text-warnb"
            title={`该文件在主仓库（${ctx.branch}）里，改动不属于任何工作区分支——要改分支请从工作区进入`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
            主仓库（非分支）
          </span>
        )}
        {truncated && (
          <span className="shrink-0 rounded bg-warn px-1 text-warn-text">
            已截断（只读）
          </span>
        )}
        {dirty && <span className="shrink-0 text-l3" title="有未保存的修改">●</span>}
        {!truncated && (
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            title={
              ctx?.kind === "main"
                ? "直接修改主项目（不属于任何分支），保存前会再确认"
                : undefined
            }
            className={`ml-auto shrink-0 rounded px-2 py-0.5 hover:bg-white/5 disabled:opacity-50 ${
              ctx?.kind === "main" ? "text-warnb" : "text-l2"
            }`}
          >
            {saving ? "保存中…" : ctx?.kind === "main" ? "保存到主仓库" : "保存"}
          </button>
        )}
      </div>
      {error && <p className="px-3 py-1 text-xs text-err-text">{error}</p>}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}

/** memo：父级重渲染不级联到 Monaco 编辑器 */
export default memo(FilePreviewEditor);
