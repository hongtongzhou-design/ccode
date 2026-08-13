import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
// mammoth 无 ESM 默认导出（export =），本项目 tsconfig 未开 esModuleInterop，用命名空间导入
import * as mammoth from "mammoth";

interface DocxBytesDto {
  data: string; // base64（同 read_pdf_bytes：raw bytes 在 macOS 会退化成数字数组）
  size: number;
}

/** base64 → Uint8Array（atob 分块；与 PdfPreview 同款，独立拷贝避免本 chunk 拖入 pdf.js） */
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

/**
 * docx 阅读版式预览（RX4a）：mammoth 把 docx 转成 HTML，复用 RX2a 的 .md-body 排版样式区。
 * 字节经 read_docx_bytes 加载（与 PDF 同一套白名单约束，50MB 上限由后端拒绝并给出提示）。
 * 渲染源是白名单根内的本地文件（可信内容），与 MarkdownView 同样不引入 sanitize 重库。
 * 图片由 mammoth 默认转成 data URI 内嵌；本组件整体被动态 import，mammoth 不进主包。
 */
function DocxPreview({
  path,
  cwdHint,
}: {
  path: string;
  /** 终端标签 cwd / 文件树根：后端白名单的第四类来源 */
  cwdHint: string | null;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState(0);

  // 加载并转换（路径切换整体重来）
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    setWarnings(0);
    void (async () => {
      try {
        const dto = await invoke<DocxBytesDto>("read_docx_bytes", {
          path,
          cwdHint,
        });
        if (cancelled) return;
        const bytes = base64ToBytes(dto.data);
        const result = await mammoth.convertToHtml({
          arrayBuffer: bytes.buffer as ArrayBuffer,
        });
        if (cancelled) return;
        setWarnings(result.messages.length);
        setHtml(result.value);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
        <span className="shrink-0 rounded-sm bg-inset px-1 text-l4">docx</span>
        {warnings > 0 && (
          <span
            className="shrink-0 text-l4"
            title="部分格式（如复杂文本框/域）在转换中被简化，以 Word 打开为准"
          >
            {warnings} 处格式已简化
          </span>
        )}
      </div>
      {error ? (
        <div className="p-3">
          <p className="text-sm text-err-text">{error}</p>
        </div>
      ) : html === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载 docx…</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            className="md-body px-5 py-4"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}

/** memo：父级重渲染不级联到 mammoth 转换 */
export default memo(DocxPreview);
