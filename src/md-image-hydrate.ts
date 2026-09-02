import { invoke } from "@tauri-apps/api/core";
import { classifyMdHref, mdImageAbsPath } from "./reader";

/** 已读过的本地图：预览重绘把节点盖回占位后，靠缓存同步换回，避免再卡在「图片加载中」 */
const CACHE_CAP = 32;
const cache = new Map<string, { mime: string; data: string }>();

function cacheGet(path: string): { mime: string; data: string } | undefined {
  const hit = cache.get(path);
  if (!hit) return undefined;
  cache.delete(path);
  cache.set(path, hit);
  return hit;
}

function cacheSet(path: string, dto: { mime: string; data: string }): void {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, dto);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function failNode(node: Element, text: string): void {
  if (!node.isConnected) return;
  const span = document.createElement("span");
  span.className = "md-img-failed";
  span.textContent = text;
  node.replaceWith(span);
}

function applyDataUrl(
  node: Element,
  dto: { mime: string; data: string },
  alt: string,
  abs?: string,
): void {
  if (!node.isConnected) return;
  const el = document.createElement("img");
  el.src = `data:${dto.mime};base64,${dto.data}`;
  el.alt = alt;
  if (abs) el.dataset.ccodePath = abs;
  node.replaceWith(el);
}

/**
 * 把 host 里剩余的 [data-md-src] 占位换成 https 直链或本地 data URL。
 * 一进来就摘掉 data-md-src，防止同一次绘制里重复发起读取。
 * 调用方应在每次 layout 都跑一遍：dangerouslySetInnerHTML 重绘后 deps 不变，
 * 不重跑就会永远停在「图片加载中」。
 */
export function hydrateMdImages(
  host: HTMLElement,
  opts: {
    fromFile: string | null;
    cwdHint: string | null | undefined;
    allowHttps: boolean;
  },
): void {
  for (const node of Array.from(host.querySelectorAll("[data-md-src]"))) {
    const src = node.getAttribute("data-md-src") ?? "";
    const alt = node.getAttribute("data-md-alt") ?? node.getAttribute("alt") ?? "";
    node.removeAttribute("data-md-src");
    node.removeAttribute("data-md-alt");
    if (!src || src.startsWith("data:")) continue;

    if (classifyMdHref(src) === "external") {
      if (opts.allowHttps && /^https:\/\//i.test(src.trim())) {
        if (!node.isConnected) continue;
        const el = document.createElement("img");
        el.referrerPolicy = "no-referrer";
        el.src = src.trim();
        el.alt = alt;
        node.replaceWith(el);
        continue;
      }
      if (!node.isConnected) continue;
      const span = document.createElement("span");
      span.className = "md-img-remote";
      span.textContent = opts.allowHttps
        ? `[外部图片未加载] ${src}`
        : `[图片] ${alt || src}`;
      node.replaceWith(span);
      continue;
    }

    if (!opts.fromFile) {
      if (!node.isConnected) continue;
      const span = document.createElement("span");
      span.className = "md-img-remote";
      span.textContent = `[图片] ${alt || src}`;
      node.replaceWith(span);
      continue;
    }

    const abs = mdImageAbsPath(src, opts.fromFile);
    if (!abs) {
      failNode(node, `[图片不可读] ${src}`);
      continue;
    }
    const cached = cacheGet(abs);
    if (cached) {
      applyDataUrl(node, cached, alt, abs);
      continue;
    }
    if (node instanceof HTMLElement) {
      node.classList.add("md-img-pending");
      node.textContent = "图片加载中…";
    }
    void invoke<{ mime: string; data: string }>("read_image_bytes", {
      path: abs,
      cwdHint: opts.cwdHint ?? null,
    })
      .then((dto) => {
        cacheSet(abs, dto);
        applyDataUrl(node, dto, alt, abs);
      })
      .catch(() => {
        failNode(node, `[图片不可读] ${src}`);
      });
  }
}
