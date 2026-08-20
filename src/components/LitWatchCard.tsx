import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import ContextMenu from "./ContextMenu";

// monaco 体积大，与终端页同款懒加载，避免拖慢工作区页首屏
const FilePreviewEditor = lazy(() => import("./FilePreviewEditor"));
import { HoverTip, useHoverTip } from "./HoverTip";
import {
  LoadingRows,
  SegTabs,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  rowActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { relTime } from "../rel-time";
import { schedulesForProject } from "../schedule-tasks";
import {
  dismissLitEntry,
  filterLitDismissed,
  groupEntriesByDay,
  includedLineFor,
  isRead,
  loadLitDismissed,
  paperResourceFor,
  pdfUrlFor,
  staleLitHint,
  weeklyBuckets,
} from "../lit-watch";
import type {
  AddIncludedResultDto,
  DownloadedPaperDto,
  IncludedEntryDto,
  WatchEntryDto,
  WatchFollowupDto,
  WatchInboxDto,
  WatchSubscriptionDto,
} from "../lit-watch";
import type { DirEntryDto } from "./FileTree";
import type {
  ProjectConfigDto,
  ProjectResourceDto,
  ScheduleDto,
  SchedulerRunDonePayload,
  WorkspaceDto,
} from "../types";

/** 资源 path 可能是绝对路径（Zotero 登记）；相对的一律按项目根拼 */
function absResourcePath(projectRoot: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${projectRoot}/${path}`;
}

/** 近 8 周命中迷你趋势（手绘 SVG 柱，不引图表库）；悬停出 HoverTip（禁原生 title） */
function TrendChart({ buckets }: { buckets: ReturnType<typeof weeklyBuckets> }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(
    null,
  );
  // 滚动/缩放即关（与 useHoverTip 同口径；SVG 柱子用不了 hook 的 ref 绑定，这里自管定位）
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip]);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const BAR_W = 12;
  const GAP = 8;
  const H = 40;
  const W = buckets.length * (BAR_W + GAP) - GAP;
  return (
    <div className="mt-1">
      <svg
        width={W}
        height={H}
        className="block"
        role="img"
        aria-label="近 8 周每周新命中数"
      >
        {buckets.map((b, i) => {
          const h =
            b.count === 0 ? 2 : Math.max(4, Math.round((b.count / max) * (H - 6)));
          return (
            <rect
              key={b.label}
              x={i * (BAR_W + GAP)}
              y={H - h}
              width={BAR_W}
              height={h}
              rx={2}
              fill={
                b.count > 0 ? "var(--color-cta)" : "var(--color-hairline)"
              }
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setTip({
                  x: Math.min(
                    Math.max(r.left + r.width / 2, 150),
                    window.innerWidth - 150,
                  ),
                  y: r.top - 8,
                  text: `${b.count} 篇 · ${b.label}`,
                });
              }}
              onMouseLeave={() => setTip(null)}
            />
          );
        })}
      </svg>
      <HoverTip tip={tip} text={tip?.text ?? ""} up />
    </div>
  );
}

type ExplainState =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "error"; error: string };

/** 新命中条目行：双行（pill + 标题 + 来源 + 日期 / 摘要截断两行点击展开），
 *  主按钮「→ 精读」常驻，◈ 解读 / ↓ 全文 / ⋯ hover 才现 */
function WatchEntryRow({
  entry,
  explain,
  downloading,
  onAddIncluded,
  onExplain,
  onCloseExplain,
  onDownload,
  onAttach,
  onDismiss,
}: {
  entry: WatchEntryDto;
  explain: ExplainState | null;
  downloading: boolean;
  onAddIncluded: () => void;
  onExplain: () => void;
  onCloseExplain: () => void;
  onDownload: () => void;
  onAttach: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 有中文一句话时标题行显示它，英文原标题进 hover tooltip
  const titleRef = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(titleRef);
  const pdfUrl = pdfUrlFor(entry.url);
  const pdfRef = useRef<HTMLButtonElement>(null);
  const pdfTip = useHoverTip(pdfRef, true);
  return (
    <li className="group rounded-md px-2 py-2 hover:bg-hover">
      <div className="flex min-w-0 items-center gap-2">
        {entry.relevance === "推荐" ? (
          <span className="shrink-0 rounded-full bg-cta-pill px-2 py-0.5 text-micro text-cta-pill-text">
            推荐
          </span>
        ) : (
          /* 纯状态 pill：inset 灰底 + 语义色小圆点（待确认=warn） */
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-micro text-l3">
            <span
              className={`size-1.5 rounded-full ${
                entry.relevance === "相关" ? "bg-l4" : "bg-warn-text"
              }`}
            />
            {entry.relevance}
          </span>
        )}
        <span
          ref={titleRef}
          onMouseEnter={entry.zhSummary ? show : undefined}
          onMouseLeave={entry.zhSummary ? hide : undefined}
          className="min-w-0 truncate text-sm text-l1"
        >
          {entry.zhSummary || entry.title}
        </span>
        {entry.zhSummary && <HoverTip tip={tip} text={entry.title} />}
        <span className="shrink-0 rounded-sm bg-inset px-1 py-0.5 text-micro text-l4">
          {entry.source}
        </span>
        {entry.date && (
          <span className="shrink-0 text-micro text-l4">
            {relTime(entry.date)}
          </span>
        )}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          className={`${rowActionClass} shrink-0`}
          onClick={onAddIncluded}
        >
          → 精读
        </button>
        <span
          className={`flex shrink-0 items-center ${hoverRevealClass}`}
        >
          <button
            type="button"
            className={ghostActionClass}
            onClick={explain ? onCloseExplain : onExplain}
          >
            ◈ 解读
          </button>
          <button
            ref={pdfRef}
            type="button"
            className={ghostActionClass}
            disabled={!pdfUrl || downloading}
            onMouseEnter={!pdfUrl ? pdfTip.show : undefined}
            onMouseLeave={!pdfUrl ? pdfTip.hide : undefined}
            onClick={onDownload}
          >
            {downloading ? "↓ 下载中…" : "↓ 全文"}
          </button>
          {!pdfUrl && <HoverTip tip={pdfTip.tip} text="出版商页面，请手动下载" up />}
          <button
            type="button"
            aria-label={`更多操作：${entry.title}`}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom + 4 });
            }}
          >
            ⋯
          </button>
        </span>
      </div>
      {entry.abstractFirst && (
        <p
          className={`mt-1 cursor-pointer text-xs leading-5 text-l3 ${expanded ? "" : "line-clamp-2"}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {entry.abstractFirst}
        </p>
      )}
      {explain && (
        <div className="mt-1 rounded-md bg-inset p-2 text-xs leading-5 text-l2">
          {explain.status === "loading" && <LoadingRows compact />}
          {explain.status === "error" && (
            <p className="text-err-text">
              解读失败：{explain.error}{" "}
              <button
                type="button"
                className="underline hover:text-l1"
                onClick={onExplain}
              >
                重试
              </button>
            </p>
          )}
          {explain.status === "ok" && (
            <p className="whitespace-pre-line">{explain.text}</p>
          )}
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            {
              label: "打开来源",
              disabled: !entry.url.trim(),
              title: entry.url.trim() ? entry.url : "这条命中没有链接",
              onSelect: () => void openUrl(entry.url),
            },
            {
              label: "关联本地 PDF…",
              title: "已手动下载全文？选中文件，自动复制进 papers/ 并登记",
              onSelect: onAttach,
            },
            { label: "忽略这条", onSelect: onDismiss },
            {
              label: "复制标题",
              onSelect: () =>
                void navigator.clipboard.writeText(entry.title).catch(() => {}),
            },
          ]}
        />
      )}
    </li>
  );
}

/** 精读清单：未读全列（超 10 条先收起）、已读默认折叠——清单随精读步骤能攒到上百条，
 *  平铺会把雷达卡片撑爆 */
function IncludedList({
  included,
  resources,
  projectRoot,
  noteNames,
  downloading,
  onOpenPdf,
  onDownload,
  onAttach,
  onRemove,
}: {
  included: IncludedEntryDto[];
  resources: ProjectResourceDto[];
  projectRoot: string;
  noteNames: string[];
  downloading: Set<string>;
  onOpenPdf: (relPath: string) => void;
  onDownload: (key: string, link: string, title: string) => void;
  onAttach: (title: string) => void;
  onRemove: (entry: IncludedEntryDto) => void;
}) {
  const UNREAD_CAP = 10;
  const [showAllUnread, setShowAllUnread] = useState(false);
  const [readOpen, setReadOpen] = useState(false);
  const unread = included.filter((e) => !isRead(e, noteNames));
  const readOnes = included.filter((e) => isRead(e, noteNames));
  const visibleUnread = showAllUnread ? unread : unread.slice(0, UNREAD_CAP);
  const renderRow = (entry: IncludedEntryDto, read: boolean) => {
    const pdf = paperResourceFor(entry, resources);
    return (
      <IncludedRow
        key={entry.lineId}
        entry={entry}
        read={read}
        pdfPath={pdf ? absResourcePath(projectRoot, pdf) : null}
        downloading={downloading.has(entry.lineId)}
        onOpen={() => pdf && onOpenPdf(pdf)}
        onDownload={() => onDownload(entry.lineId, entry.link, entry.title)}
        onAttach={() => onAttach(entry.title)}
        onRemove={() => onRemove(entry)}
      />
    );
  };
  return (
    <ul className="mt-1 space-y-0.5">
      {visibleUnread.map((e) => renderRow(e, false))}
      {unread.length > UNREAD_CAP && (
        <li className="px-2 py-1">
          <button
            type="button"
            onClick={() => setShowAllUnread((v) => !v)}
            className="text-xs text-l4 hover:text-l2"
          >
            {showAllUnread
              ? "▾ 收起"
              : `▸ 展开其余 ${unread.length - UNREAD_CAP} 条未读`}
          </button>
        </li>
      )}
      {readOnes.length > 0 && (
        <li className="px-2 py-1">
          <button
            type="button"
            onClick={() => setReadOpen((v) => !v)}
            className="text-xs text-l4 hover:text-l2"
          >
            {readOpen ? "▾" : "▸"} 已读 {readOnes.length} 条
          </button>
        </li>
      )}
      {readOpen && readOnes.map((e) => renderRow(e, true))}
    </ul>
  );
}

/** 精读清单行：状态点（已读绿/未读灰）+ 标题 + 作者年份 + 主按钮（开读 / ↓ 全文）+ ⋯ */
function IncludedRow({
  entry,
  read,
  pdfPath,
  downloading,
  onOpen,
  onDownload,
  onAttach,
  onRemove,
}: {
  entry: IncludedEntryDto;
  read: boolean;
  /** 已下载 PDF 的绝对路径；null = 还没下载 */
  pdfPath: string | null;
  downloading: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onAttach: () => void;
  onRemove: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(dotRef);
  const pdfUrl = pdfUrlFor(entry.link);
  const canDownload = pdfUrl !== null;
  const pdfRef = useRef<HTMLButtonElement>(null);
  const pdfTip = useHoverTip(pdfRef, true);
  return (
    <li className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
      <span
        ref={dotRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`size-2 shrink-0 rounded-full ${read ? "bg-ok-text" : "bg-l4"}`}
      />
      <HoverTip tip={tip} text={read ? "已读（notes/ 里有对应笔记）" : "未读"} />
      <span className="min-w-0 flex-1 truncate text-sm text-l2">
        {entry.title}
      </span>
      {entry.authorsYear && (
        <span className="shrink-0 text-micro text-l4">{entry.authorsYear}</span>
      )}
      {pdfPath ? (
        <button
          type="button"
          className={`${rowActionClass} shrink-0`}
          onClick={onOpen}
        >
          开读
        </button>
      ) : (
        <>
          <button
            ref={pdfRef}
            type="button"
            className={`${rowActionClass} shrink-0`}
            disabled={!canDownload || downloading}
            onMouseEnter={!canDownload ? pdfTip.show : undefined}
            onMouseLeave={!canDownload ? pdfTip.hide : undefined}
            onClick={onDownload}
          >
            {downloading ? "↓ 下载中…" : "↓ 全文"}
          </button>
          {!canDownload && (
            <HoverTip tip={pdfTip.tip} text="出版商页面，请手动下载" up />
          )}
        </>
      )}
      <button
        type="button"
        aria-label={`更多操作：${entry.title}`}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.bottom + 4 });
        }}
      >
        ⋯
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            ...(!pdfPath
              ? [
                  {
                    label: "↓ 获取全文",
                    disabled: !canDownload,
                    title: canDownload ? pdfUrl! : "出版商页面，请手动下载",
                    onSelect: onDownload,
                  },
                  {
                    label: "关联本地 PDF…",
                    title: "已手动下载全文？选中文件，自动复制进 papers/ 并登记",
                    onSelect: onAttach,
                  },
                ]
              : []),
            {
              label: "打开来源",
              disabled: !entry.link.trim(),
              title: entry.link.trim() ? entry.link : "这条没有链接",
              onSelect: () => void openUrl(entry.link),
            },
            { label: "移出清单", danger: true, onSelect: onRemove },
          ]}
        />
      )}
    </li>
  );
}

/** 订阅弹层（w-[36rem] 富表单档）：表格化编辑 watchlist.md（关键词 + 来源多选 + 备注） */
function SubscriptionsModal({
  projectRoot,
  initial,
  onClose,
  onSaved,
}: {
  projectRoot: string;
  initial: WatchSubscriptionDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<WatchSubscriptionDto[]>(
    initial.length > 0
      ? initial.map((s) => ({ ...s, sources: [...s.sources] }))
      : [{ keyword: "", sources: [], note: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 原地编辑源文件：不跳终端页，弹层内嵌 FilePreviewEditor
  const [sourceOpen, setSourceOpen] = useState(false);
  const SOURCES = ["arxiv", "openalex", "crossref"] as const;

  // 源文件可能被用户手改过：关掉编辑器后重读清单刷新表格（读失败保留当前编辑内容）
  async function reloadRows() {
    try {
      const subs = await invoke<WatchSubscriptionDto[]>(
        "list_watch_subscriptions",
        { projectRoot },
      );
      setRows(
        subs.length > 0
          ? subs.map((s) => ({ ...s, sources: [...s.sources] }))
          : [{ keyword: "", sources: [], note: "" }],
      );
    } catch {
      /* 保留当前编辑内容 */
    }
  }

  function patchRow(i: number, patch: Partial<WatchSubscriptionDto>) {
    setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const subs = rows
      .map((r) => ({
        keyword: r.keyword.trim(),
        sources: r.sources,
        note: r.note.trim(),
      }))
      .filter((r) => r.keyword !== "");
    setBusy(true);
    setError(null);
    try {
      await invoke("save_watch_subscriptions", { projectRoot, subs });
      onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 ccode-fade"
        onClick={onClose}
      >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        className="w-[36rem] rounded-md border border-field ccode-float-surface p-5"
      >
        <h2 className="mb-1 text-base font-semibold text-l1">追踪关键词</h2>
        <p className="mb-4 text-xs text-l3">
          雷达按这些关键词定期检索，新命中进「新命中」列表。
        </p>
        <div className="max-h-72 space-y-2 overflow-auto">
          {rows.map((row, i) => (
            <div key={i} className="flex min-w-0 items-center gap-2">
              <input
                className={`${fieldClass} min-w-0 flex-1`}
                value={row.keyword}
                onChange={(e) => patchRow(i, { keyword: e.target.value })}
                placeholder="关键词，如 mixture-of-experts"
              />
              <span className="flex shrink-0 items-center gap-1">
                {SOURCES.map((src) => {
                  const on = row.sources.includes(src);
                  return (
                    <button
                      key={src}
                      type="button"
                      onClick={() =>
                        patchRow(i, {
                          sources: on
                            ? row.sources.filter((s) => s !== src)
                            : [...row.sources, src],
                        })
                      }
                      className={`flex h-6 items-center rounded-full px-2 text-xs transition-colors ${
                        on ? "bg-seg-sel text-l1" : "bg-inset text-l3 hover:text-l1"
                      }`}
                    >
                      {src}
                    </button>
                  );
                })}
              </span>
              {/* 备注固定 9rem：fieldClass 自带 w-full，须用外层 span 约束，否则挤死关键词列 */}
              <span className="w-36 shrink-0">
                <input
                  className={fieldClass}
                  value={row.note}
                  onChange={(e) => patchRow(i, { note: e.target.value })}
                  placeholder="备注（可选）"
                />
              </span>
              <button
                type="button"
                aria-label="删除该行"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                onClick={() =>
                  setRows((cur) =>
                    cur.length > 1 ? cur.filter((_, j) => j !== i) : cur,
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={`${ghostActionClass} mt-2`}
          onClick={() =>
            setRows((cur) => [...cur, { keyword: "", sources: [], note: "" }])
          }
        >
          ＋ 加一行
        </button>
        {error && <p className="mt-2 text-sm text-err-text">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            className="mr-auto rounded-sm px-3 py-1.5 text-sm text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
            onClick={() => {
              // 先把已保存的订阅落盘再原地打开——文件不存在时直接预览只会看到「文件不存在」；
              // 刻意写 initial 而非当前编辑中的 rows，保住「取消」的语义
              setBusy(true);
              setError(null);
              invoke("save_watch_subscriptions", {
                projectRoot,
                subs: initial,
              })
                .then(() => setSourceOpen(true))
                .catch((reason) => setError(String(reason)))
                .finally(() => setBusy(false));
            }}
          >
            编辑源文件
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
      </div>
      {/* 源文件原地编辑层：monaco 懒加载；关闭后重读清单同步表格 */}
      {sourceOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 ccode-fade"
          onClick={() => {
            setSourceOpen(false);
            void reloadRows();
          }}
        >
          <div
            className="flex h-[70vh] w-[48rem] max-w-[92vw] flex-col overflow-hidden rounded-md ccode-float-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <span className="text-sm text-l1">watchlist.md</span>
              <span className="text-micro text-l4">papers/ · 保存后下次巡检生效</span>
              <button
                type="button"
                className={`${ghostActionClass} ml-auto`}
                onClick={() => {
                  setSourceOpen(false);
                  void reloadRows();
                }}
              >
                × 关闭
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <Suspense
                fallback={
                  <p className="p-4 text-xs text-l4">编辑器加载中…</p>
                }
              >
                <FilePreviewEditor
                  path={`${projectRoot}/papers/watchlist.md`}
                  root={projectRoot}
                />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 项目详情工作段的「◔ 文献雷达」卡片（lit_watch.rs + scheduler.rs 的前端）：
 * 新命中（趋势 + 日分组 + 处置动作）/ 精读清单（已读状态 + 开读）双页签；
 * 订阅与定时任务的编辑入口也在卡头（定时区块在项目设置抽屉里，onOpenSchedules 开抽屉滚动过去）。
 * 列表自取自刷：挂载拉一次，scheduler-run-done 事件到达重拉。
 */
export default function LitWatchCard({
  projectRoot,
  cfg,
  workspaces,
  onOpenSchedules,
  onConfigChanged,
}: {
  projectRoot: string;
  cfg: ProjectConfigDto;
  workspaces: WorkspaceDto[];
  /** 「◔ 定时」：打开项目设置抽屉并滚到定时任务区块 */
  onOpenSchedules: () => void;
  /** 下载 PDF 会登记进 project.toml 资源清单：通知父级重读档案卡 */
  onConfigChanged: () => void;
}) {
  const [entries, setEntries] = useState<WatchEntryDto[] | null>(null);
  const [followups, setFollowups] = useState<WatchFollowupDto[]>([]);
  const [subs, setSubs] = useState<WatchSubscriptionDto[] | null>(null);
  const [included, setIncluded] = useState<IncludedEntryDto[] | null>(null);
  /** notes/ 目录文件名（已读判定用）；目录不存在 = 空表 = 全部未读 */
  const [noteNames, setNoteNames] = useState<string[]>([]);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"new" | "included">("new");
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    loadLitDismissed(),
  );
  const [subsOpen, setSubsOpen] = useState(false);
  const [followupsOpen, setFollowupsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [explains, setExplains] = useState<Record<string, ExplainState>>({});
  /** 解读展开态与结果缓存分离：收起不丢缓存，再展开直接复用（不重复调 AI） */
  const [explainOpen, setExplainOpen] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  // 成功 toast（同 GitPanel 口径：CTA 绿底右下角 2.5s 自收）
  const [toast, setToast] = useState<{ text: string; hiding: boolean } | null>(
    null,
  );
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  const setPage = useAppStore((s) => s.setPage);

  function showToast(text: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, hiding: false });
    toastTimerRef.current = setTimeout(() => {
      setToast((t) => (t ? { ...t, hiding: true } : t));
      toastTimerRef.current = setTimeout(() => setToast(null), 300);
    }, 2200);
  }

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  async function load() {
    const [inbox, subList, includedList, scheduleList, notes] =
      await Promise.all([
        invoke<WatchInboxDto>("list_watch_entries", { projectRoot }).catch(
          (reason) => {
            setError(String(reason));
            return null;
          },
        ),
        invoke<WatchSubscriptionDto[]>("list_watch_subscriptions", {
          projectRoot,
        }).catch(() => null),
        invoke<IncludedEntryDto[]>("list_included_entries", {
          projectRoot,
        }).catch(() => null),
        invoke<ScheduleDto[]>("list_schedules").catch(() => null),
        // notes 目录不存在 = 还没有笔记 = 全部未读（诚实回落，不硬猜）
        invoke<DirEntryDto[]>("list_dir", {
          path: `${projectRoot}/notes`,
          showHidden: false,
        }).catch(() => [] as DirEntryDto[]),
      ]);
    if (inbox) {
      setEntries(inbox.entries);
      setFollowups(inbox.followups);
      setError(null);
    }
    if (subList) setSubs(subList);
    if (includedList) setIncluded(includedList);
    if (scheduleList)
      setSchedules(schedulesForProject(scheduleList, projectRoot));
    setNoteNames(notes.filter((n) => !n.isDir).map((n) => n.name));
  }

  useEffect(() => {
    let stale = false;
    const reload = () => {
      if (!stale) void load();
    };
    reload();
    let unlisten: (() => void) | undefined;
    listen<SchedulerRunDonePayload>("scheduler-run-done", () => {
      setRunning(false);
      reload();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  /** 最近一次成功 run（卡头时间 / 立即跑 / 漂移提醒共用） */
  const lastOkRun = (s: ScheduleDto) => s.history.find((r) => r.status === "ok");
  const lastRunAt = (schedules ?? [])
    .map((s) => s.lastRunAt)
    .filter((v): v is string => v !== null)
    .sort()
    .pop();

  async function runNow() {
    const s = schedules?.find((x) => x.enabled) ?? schedules?.[0];
    if (!s) return;
    setRunning(true);
    setError(null);
    try {
      await invoke("run_schedule_now", { id: s.id });
      // 成功拉起后结果走 scheduler-run-done 事件（监听里清 running 并重拉）
    } catch (reason) {
      setRunning(false);
      setError(String(reason));
    }
  }

  /** ◈ 解读：ai_prompt 不传功能键（走自动回落链）；结果随组件状态缓存，失败行内报错可重试 */
  async function explain(entry: WatchEntryDto) {
    setExplainOpen((cur) => new Set(cur).add(entry.id));
    setExplains((cur) => ({ ...cur, [entry.id]: { status: "loading" } }));
    const topicLine = cfg.topic?.trim()
      ? `3. 和本课题的关系（课题：${cfg.topic.trim()}）`
      : "3. 它适合用在什么研究方向";
    const prompt = `请用中文解读下面这篇文献，严格输出三行，每行不超过 40 字，不要任何额外内容：
1. 做了什么
2. 为什么重要
${topicLine}

标题：${entry.title}
摘要：${entry.abstractFirst || "（无摘要）"}`;
    try {
      const text = await invoke<string>("ai_prompt", {
        profileId: null,
        fnKey: null,
        prompt,
      });
      setExplains((cur) => ({
        ...cur,
        [entry.id]: { status: "ok", text: text.trim() },
      }));
    } catch (reason) {
      setExplains((cur) => ({
        ...cur,
        [entry.id]: { status: "error", error: String(reason) },
      }));
    }
  }

  async function addToIncluded(entry: WatchEntryDto) {
    try {
      const res = await invoke<AddIncludedResultDto>("add_included_entry", {
        projectRoot,
        ...includedLineFor(entry),
      });
      if (res.added) {
        showToast("已加入精读清单");
        setIncluded(
          await invoke<IncludedEntryDto[]>("list_included_entries", {
            projectRoot,
          }),
        );
      } else {
        showToast("已在精读清单");
      }
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 下载全文（命中条目 / 精读条目共用）：key 用于行内「下载中」态 */
  async function download(key: string, url: string, fileNameHint: string) {
    const pdfUrl = pdfUrlFor(url);
    if (!pdfUrl) return;
    setDownloading((cur) => new Set(cur).add(key));
    try {
      const res = await invoke<DownloadedPaperDto>("download_paper_pdf", {
        projectRoot,
        url: pdfUrl,
        fileNameHint,
      });
      showToast(`已下载：${res.name}`);
      // PDF 已登记进 project.toml 资源清单：让父级重读，精读行主按钮随即变「开读」
      onConfigChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setDownloading((cur) => {
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
    }
  }

  /** 关联本地 PDF（命中条目 / 精读条目共用 ⋯ 菜单）：文件对话框选 PDF，
   *  后端复制进 papers/ 并按标题登记 project.toml，父级重读后精读行主按钮变「开读」 */
  async function attachPdf(title: string) {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof selected !== "string") return; // 取消或异常形态
    try {
      const res = await invoke<DownloadedPaperDto>("attach_paper_pdf", {
        projectRoot,
        sourcePath: selected,
        title,
      });
      showToast(`已关联：${res.name}`);
      onConfigChanged();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function removeIncluded(entry: IncludedEntryDto) {
    try {
      await invoke("remove_included_entry", {
        projectRoot,
        lineId: entry.lineId,
      });
      setIncluded(
        await invoke<IncludedEntryDto[]>("list_included_entries", {
          projectRoot,
        }),
      );
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 精读清单「开读」→ 沉浸式阅读区（批次 B1：笔记 | PDF | 对话 三栏） */
  function openPdf(relPath: string) {
    const abs = absResourcePath(projectRoot, relPath);
    setReaderReq({ pdfPath: abs, projectRoot });
    setPage("terminal");
  }

  const resources: ProjectResourceDto[] = cfg.resources ?? [];
  const visibleEntries = filterLitDismissed(entries ?? [], dismissed);
  const buckets = weeklyBuckets(entries ?? []);
  const hasSubs = (subs ?? []).length > 0;
  // 关联步骤漂移提醒（只提醒不阻断）：任一任务命中即显示
  const staleStep = (schedules ?? []).find((s) => {
    if (!s.linkedStep) return false;
    const step = cfg.steps.find((st) => st.name === s.linkedStep);
    if (!step) return false;
    const ws = workspaces.find((w) => w.name === step.workspaceName);
    const okRun = lastOkRun(s);
    return staleLitHint(
      s.linkedStep,
      s.lastStatus === "ok" ? s.lastRunAt : (okRun?.at ?? null),
      okRun?.newEntries ?? 0,
      ws ? (ws.mergedAt ?? ws.createdAt) : null,
    );
  })?.linkedStep;

  return (
    <section className="mb-4 rounded-lg bg-strip p-3">
      {/* 卡头：标题 + 上次巡检相对时间；右侧次级动作（立即跑有任务才显示） */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-l1">◔ 文献雷达</span>
        {lastRunAt && (
          <span className="text-micro text-l4">
            上次巡检 {relTime(lastRunAt)}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {schedules !== null && schedules.length > 0 && (
            <button
              type="button"
              className={ghostActionClass}
              disabled={running}
              onClick={() => void runNow()}
            >
              {running ? "◔ 运行中…" : "⟳ 立即跑"}
            </button>
          )}
          <button
            type="button"
            className={ghostActionClass}
            onClick={() => setSubsOpen(true)}
          >
            订阅
          </button>
          <button
            type="button"
            className={ghostActionClass}
            onClick={onOpenSchedules}
          >
            ◔ 定时
          </button>
        </div>
      </div>
      {staleStep && (
        <p className="mt-1 text-xs text-warn-text">
          雷达有新命中，「{staleStep}」步的产物可能过期
        </p>
      )}
      {error && <p className="mt-1 text-xs text-err-text">{error}</p>}

      {subs !== null && !hasSubs ? (
        /* 无订阅：整卡引导（虚线引导卡先例），整块即「添加第一条」按钮 */
        <button
          type="button"
          className="mt-2 block w-full rounded-md border border-dashed border-field px-3 py-4 text-center text-xs text-l3 hover:bg-hover hover:text-l1"
          onClick={() => setSubsOpen(true)}
        >
          还没有追踪关键词，添加第一条
        </button>
      ) : (
        <>
          <SegTabs
            className="mt-2"
            items={[
              { id: "new" as const, label: `新命中 ${visibleEntries.length}` },
              { id: "included" as const, label: `精读清单 ${included?.length ?? 0}` },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "new" &&
            (entries === null ? (
              <LoadingRows compact />
            ) : (
              <>
                <TrendChart buckets={buckets} />
                {visibleEntries.length === 0 && (
                  <p className="mt-2 text-xs text-l4">暂无新命中</p>
                )}
                {groupEntriesByDay(visibleEntries).map((group) => (
                  <div key={group.key} className="mt-2">
                    <p className="px-2 text-micro text-l4">{group.label}</p>
                    <ul className="space-y-0.5">
                      {group.entries.map((entry) => (
                        <WatchEntryRow
                          key={entry.id}
                          entry={entry}
                          explain={
                            explainOpen.has(entry.id)
                              ? (explains[entry.id] ?? { status: "loading" as const })
                              : null
                          }
                          downloading={downloading.has(entry.id)}
                          onAddIncluded={() => void addToIncluded(entry)}
                          onExplain={() => {
                            const cur = explains[entry.id];
                            if (cur && cur.status !== "error") {
                              // 已有结果：只展开不重调（缓存复用）；失败态点「重试」才重调
                              setExplainOpen((c) => new Set(c).add(entry.id));
                            } else {
                              void explain(entry);
                            }
                          }}
                          onCloseExplain={() =>
                            setExplainOpen((cur) => {
                              const next = new Set(cur);
                              next.delete(entry.id);
                              return next;
                            })
                          }
                          onDownload={() =>
                            void download(entry.id, entry.url, entry.title)
                          }
                          onAttach={() => void attachPdf(entry.title)}
                          onDismiss={() =>
                            setDismissed((cur) => dismissLitEntry(cur, entry.id))
                          }
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {followups.length > 0 && (
                  <div className="mt-2">
                    <button
                      type="button"
                      className="flex items-center gap-1 px-2 text-xs text-l3 hover:text-l1"
                      onClick={() => setFollowupsOpen((v) => !v)}
                      aria-expanded={followupsOpen}
                    >
                      <span>{followupsOpen ? "▾" : "▸"}</span>
                      待人工下载（{followups.length}）
                    </button>
                    {followupsOpen && (
                      <ul className="mt-1 space-y-0.5">
                        {followups.map((f, i) => (
                          <li
                            key={`${f.title}-${i}`}
                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
                          >
                            <span className="min-w-0 flex-1 truncate text-xs text-l2">
                              {f.title}
                            </span>
                            {f.note && (
                              <span className="shrink-0 text-micro text-l4">
                                {f.note}
                              </span>
                            )}
                            {f.url.trim() && (
                              <button
                                type="button"
                                className={`${ghostActionClass} shrink-0`}
                                onClick={() => void openUrl(f.url)}
                              >
                                打开来源
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            ))}
          {tab === "included" &&
            (included === null ? (
              <LoadingRows compact />
            ) : included.length === 0 ? (
              <p className="mt-2 px-2 text-xs text-l4">
                还没有精读条目。在「新命中」里点「→ 精读」加进来。
              </p>
            ) : (
              <IncludedList
                included={included}
                resources={resources}
                projectRoot={projectRoot}
                noteNames={noteNames}
                downloading={downloading}
                onOpenPdf={openPdf}
                onDownload={(key, link, title) => void download(key, link, title)}
                onAttach={(title) => void attachPdf(title)}
                onRemove={(entry) => void removeIncluded(entry)}
              />
            ))}
        </>
      )}

      {subsOpen && subs !== null && (
        <SubscriptionsModal
          projectRoot={projectRoot}
          initial={subs}
          onClose={() => setSubsOpen(false)}
          onSaved={() => {
            setSubsOpen(false);
            void load();
          }}
        />
      )}
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-md border border-cta-bd bg-cta px-3 py-2 text-sm text-cta-text transition-all duration-300 ${
            toast.hiding ? "translate-y-1 opacity-0" : "translate-y-0 opacity-100"
          }`}
        >
          <span>✓</span>
          <span>{toast.text}</span>
        </div>
      )}
    </section>
  );
}
