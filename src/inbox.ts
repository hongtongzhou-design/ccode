/**
 * 「待你处理」收件箱的分类纯逻辑 + 人工请求（help:）的屏蔽/通知判定。
 * 与 DOM/Tauri 解耦（localStorage 薄层除外），供 node --test 直接测。
 * 触发链路：WorkspacesPage 构造条目（key 前缀即类别）→ App 标题栏 / 页内 strip
 * 按 groupInbox 分组渲染类别胶囊，点开下拉只看该类条目。
 */
import { NOTIFY_DEBOUNCE_MS } from "./notify.ts";

export type InboxCategory =
  | "conflict"
  | "confirm"
  | "ready"
  | "artifacts"
  | "digest"
  | "profile"
  | "help";

export interface InboxCategoryMeta {
  id: InboxCategory;
  label: string;
}

/** 固定展示顺序（与原 strip 摘要口径一致，confirm: 与 live: 合并为「待确认」；help 追加在末尾） */
export const INBOX_CATEGORIES: readonly InboxCategoryMeta[] = [
  { id: "conflict", label: "冲突" },
  { id: "confirm", label: "待确认" },
  { id: "ready", label: "可合并" },
  { id: "artifacts", label: "待核验" },
  { id: "digest", label: "待发送" },
  { id: "profile", label: "配置失效" },
  { id: "help", label: "人工请求" },
];

/** 从条目 key 前缀推导类别；未知前缀回落待确认（warn 语义），保证新条目不静默丢失 */
export function inboxCategoryOf(key: string): InboxCategory {
  if (key.startsWith("conflict:")) return "conflict";
  if (key.startsWith("confirm:") || key.startsWith("live:")) return "confirm";
  if (key.startsWith("ready:")) return "ready";
  if (key.startsWith("artifacts:")) return "artifacts";
  if (key.startsWith("digest")) return "digest";
  if (key.startsWith("profile:")) return "profile";
  if (key.startsWith("help:")) return "help";
  return "confirm";
}

export function inboxCategoryLabel(category: InboxCategory): string {
  return INBOX_CATEGORIES.find((meta) => meta.id === category)?.label ?? "待确认";
}

export interface InboxGroup<T> {
  category: InboxCategory;
  label: string;
  items: T[];
}

/** 按类别分组：固定 INBOX_CATEGORIES 顺序，空类不返回；类内保持条目原顺序 */
export function groupInbox<T extends { key: string }>(
  items: readonly T[],
): InboxGroup<T>[] {
  return INBOX_CATEGORIES.map((meta) => ({
    category: meta.id,
    label: meta.label,
    items: items.filter((it) => inboxCategoryOf(it.key) === meta.id),
  })).filter((group) => group.items.length > 0);
}

/** help: 条目屏蔽表的 localStorage 键：{ [root]: 条目签名 } */
export const HELP_DISMISSED_KEY = "ccode.helpDismissed";

/** 请求条目签名：文件内容变化（签名不同）时旧屏蔽自动失效、条目复现 */
export function helpSignature(items: readonly string[]): string {
  return items.join("|");
}

/** 命中屏蔽表且签名一致 = 不生成该 help 条目 */
export function isHelpDismissed(
  dismissed: Record<string, string>,
  root: string,
  signature: string,
): boolean {
  return dismissed[root] === signature;
}

/** 解析屏蔽表原文：坏 JSON / 非对象 / 非字符串值一律容错为空表 */
export function parseHelpDismissed(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => typeof v === "string"),
    );
  } catch {
    return {};
  }
}

/** 首条请求预览：截断 max 字，超出加省略号 */
export function helpPreview(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 人工请求新来源判定（edge-trigger）：next 中存在而 prev 中不存在的 key，
 * 且距上次通知该 key 已满去抖窗口（同 root 30 秒内最多一条）。
 * prev 为 null = 基线未建立（首轮刷新），一律不通知，防启动误报。
 */
export function helpNotifyKeys(
  prev: ReadonlySet<string> | null,
  next: readonly string[],
  lastSentAt: ReadonlyMap<string, number>,
  now: number,
  windowMs: number = NOTIFY_DEBOUNCE_MS,
): string[] {
  if (prev === null) return [];
  return next.filter((key) => {
    if (prev.has(key)) return false;
    const last = lastSentAt.get(key);
    return last === undefined || now - last >= windowMs;
  });
}

// ---- localStorage 薄层（以下依赖 DOM，不进 node 测试） ----

export function loadHelpDismissed(): Record<string, string> {
  try {
    return parseHelpDismissed(localStorage.getItem(HELP_DISMISSED_KEY));
  } catch {
    return {};
  }
}

/** 记录屏蔽（root + 当前签名）并返回新表；写入失败静默（隐私模式等） */
export function dismissHelp(
  root: string,
  signature: string,
): Record<string, string> {
  const next = { ...loadHelpDismissed(), [root]: signature };
  try {
    localStorage.setItem(HELP_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* 写不进就只靠本次内存态 */
  }
  return next;
}
