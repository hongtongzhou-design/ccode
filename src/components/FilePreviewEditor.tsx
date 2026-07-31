import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";

// 只用基础 editor worker（不需要语言服务的 intellisense）
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

// 与暖黑主题一致的 monaco 主题（定义一次）
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

/**
 * 文件预览编辑器（P4）：Monaco 取代只读 pre。
 * 内容经 read_file_preview 加载（根目录约束、二进制/截断处理沿用后端），
 * 脏状态上报给调用方（预览页签的脏点），保存走 save_file_preview（原子写）。
 */
export default function FilePreviewEditor({
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
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

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

  // 创建/更新编辑器（截断文件只读，避免保存出不完整内容）
  useEffect(() => {
    if (text === null || !hostRef.current) return;
    const ed = monaco.editor.create(hostRef.current, {
      value: text,
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
      setDirty(true);
      onDirtyChange?.(true);
    });
    return () => {
      sub.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, truncated]);

  async function onSave() {
    const ed = editorRef.current;
    if (!ed) return;
    setSaving(true);
    setError(null);
    try {
      await invoke("save_file_preview", { path, root, text: ed.getValue() });
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
            className="ml-auto shrink-0 rounded px-2 py-0.5 text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        )}
      </div>
      {error && <p className="px-3 py-1 text-xs text-err-text">{error}</p>}
      <div ref={hostRef} className="min-h-0 flex-1" />
    </div>
  );
}
