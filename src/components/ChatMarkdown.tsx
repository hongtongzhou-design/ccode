import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Marked } from "marked";
import { useAppStore } from "../store";
import { classifyMdHref, resolveMdPath } from "../reader";

/**
 * 聊天消息 Markdown 渲染（AI 回复正文；用户气泡保持纯文本）。
 * 与 FilePreviewEditor 的 MarkdownView 的关键差异：会话内容可能含联网抓取的文本，
 * 按不可信处理——用独立 Marked 实例（不碰 md-math 注册的全局实例），原始 HTML 一律转义
 * （raw <img> 会成为追踪像素/外泄通道）；聊天场景单换行很常见，开 breaks。
 * 图片与链接口径同 MarkdownView（批次 B2）：http(s) 图片不加载只显示文本，
 * 本地图片经 read_image_bytes 白名单换 data URL；外链走系统浏览器，本地路径跳终端页预览。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const chatMarked = new Marked({ gfm: true, breaks: true, async: false });
chatMarked.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

export default function ChatMarkdown({
  text,
  cwd,
}: {
  text: string;
  /** 会话工作目录：相对图片/链接的解析基准 + read_image_bytes 的 cwdHint */
  cwd?: string | null;
}) {
  const html = useMemo(() => chatMarked.parse(text) as string, [text]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  // resolveMdPath 按「文件所在目录」解析相对路径：传 cwd 下的伪文件名，目录即 cwd
  const baseFile = cwd ? `${cwd}/_` : null;

  // 图片后处理（同 MarkdownView 口径；落地守卫只用 isConnected，理由见该文件注释）。
  // 成功换 data URL 时把绝对路径记在 dataset 上，点击可跳预览页签放大看
  useEffect(() => {
    const host = bodyRef.current;
    if (!host) return;
    for (const img of Array.from(host.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) continue;
      const alt = img.getAttribute("alt") ?? "";
      if (classifyMdHref(src) === "external" || !baseFile) {
        const span = document.createElement("span");
        span.className = "md-img-remote";
        span.textContent = `[图片] ${alt || src}`;
        img.replaceWith(span);
        continue;
      }
      const abs = resolveMdPath(baseFile, src);
      const ph = document.createElement("span");
      ph.className = "md-img-pending";
      ph.textContent = "图片加载中…";
      img.replaceWith(ph);
      void invoke<{ mime: string; data: string }>("read_image_bytes", {
        path: abs,
        cwdHint: cwd,
      })
        .then((dto) => {
          if (!ph.isConnected) return;
          const el = document.createElement("img");
          el.src = `data:${dto.mime};base64,${dto.data}`;
          el.alt = alt;
          el.dataset.ccodePath = abs;
          ph.replaceWith(el);
        })
        .catch(() => {
          if (!ph.isConnected) return;
          const span = document.createElement("span");
          span.className = "md-img-failed";
          span.textContent = `[图片不可读] ${src}`;
          ph.replaceWith(span);
        });
    }
  }, [html, baseFile, cwd]);

  /** 链接：锚点默认；外链系统浏览器；本地路径跳终端页预览。图片点击 = 预览放大 */
  function onBodyClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const img = target.closest("img");
    if (img?.dataset.ccodePath && cwd) {
      const abs = img.dataset.ccodePath;
      setPreviewReq({
        path: abs,
        name: abs.split(/[\\/]/).pop() ?? abs,
        root: cwd,
      });
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    const kind = classifyMdHref(href);
    if (kind === "anchor") return;
    e.preventDefault();
    if (kind === "external" || kind === "other") {
      void openUrl(href).catch(() => {});
      return;
    }
    if (!baseFile || !cwd) return;
    const abs = resolveMdPath(baseFile, href);
    setPreviewReq({
      path: abs,
      name: abs.split(/[\\/]/).pop() ?? abs,
      root: cwd,
    });
  }

  return (
    <div
      ref={bodyRef}
      onClick={onBodyClick}
      className="md-body md-chat"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 消息级图片卡：整行图片路径经 read_image_bytes 白名单换 data URL 内嵌，点击放大到预览页签；
 *  不可读（白名单外/文件已删）回落为路径文本卡。相对路径以 cwd 为基准解析 */
export function ChatImageCard({
  path,
  cwd,
}: {
  path: string;
  cwd?: string | null;
}) {
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const abs = cwd ? resolveMdPath(`${cwd}/_`, path) : path;
  const name = abs.split(/[\\/]/).pop() ?? abs;

  useEffect(() => {
    let stale = false;
    setSrc(null);
    setFailed(false);
    invoke<{ mime: string; data: string }>("read_image_bytes", {
      path: abs,
      cwdHint: cwd ?? null,
    })
      .then((dto) => {
        if (!stale) setSrc(`data:${dto.mime};base64,${dto.data}`);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [abs, cwd]);

  if (failed)
    return (
      <div
        className="my-1 break-all rounded-md border border-hairline bg-inset px-2.5 py-1.5 font-mono text-xs text-l3"
        title={abs}
      >
        🖼 {name}（不在可读取范围或文件已删除）
      </div>
    );
  if (!src) return <div className="md-img-pending my-1">图片加载中…</div>;
  return (
    <button
      type="button"
      className="my-1 block cursor-zoom-in border-0 bg-transparent p-0"
      title={`${name}（点击放大预览）`}
      onClick={() => {
        if (cwd)
          setPreviewReq({ path: abs, name, root: cwd });
      }}
    >
      <img
        src={src}
        alt={name}
        className="max-h-64 max-w-full rounded-md border border-hairline object-contain"
      />
    </button>
  );
}
