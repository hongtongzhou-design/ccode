import { useEffect, useState } from "react";
import { LoadingRows, hoverRevealClass } from "./PageFrame";
import type {
  GlossaryEntry,
  ReaderOutlineItem,
  ReaderTranslation,
} from "../reader";

/**
 * 阅读区 Agent 栏「✦ 工具」页签（批次 B3）：三段折叠——
 * 译（当前对照卡 + 本次会话历史译段，组件态不落库）/ 生词本（notes/glossary.md 表格 + 行尾 ×删除）/
 * 大纲（PDF 目录树，点击跳页）。划词翻译或段落对照触发时由父级切到本页签并经 expandNonce 展开「译」段。
 */
export default function ReaderToolsPanel({
  translations,
  translating,
  glossary,
  outline,
  expandNonce,
  onSaveTranslation,
  onRemoveTranslation,
  onRemoveGlossary,
  onJumpPage,
}: {
  /** 会话内译段（新→旧；[0] 为当前对照卡，其余进历史列表） */
  translations: readonly ReaderTranslation[];
  /** 有翻译在途（「译」段顶部骨架卡） */
  translating: boolean;
  glossary: readonly GlossaryEntry[];
  /** null = 目录还在解析 */
  outline: ReaderOutlineItem[] | null;
  /** 数值变化 = 自动展开「译」段（划词翻译/段落对照触发） */
  expandNonce: number;
  /** 保存译段到笔记「## 译段」；返回 null 成功，否则为提示 */
  onSaveTranslation: (t: ReaderTranslation) => Promise<string | null>;
  /** 历史条目 ×删除（只是移除列表项，不动笔记） */
  onRemoveTranslation: (id: number) => void;
  /** 生词 ×删除（后端精确匹配删行，高亮随列表刷新同步消失） */
  onRemoveGlossary: (term: string) => void;
  /** 大纲条目点击跳页 */
  onJumpPage: (page: number) => void;
}) {
  const [open, setOpen] = useState({ trans: true, gloss: false, outline: false });
  const [savingId, setSavingId] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // 划词翻译/段落对照触发：自动展开「译」段（切页签由 ReaderOverlay 负责）
  useEffect(() => {
    if (expandNonce > 0) setOpen((o) => ({ ...o, trans: true }));
  }, [expandNonce]);

  async function save(t: ReaderTranslation) {
    if (savingId !== null || t.saved) return;
    setSavingId(t.id);
    setSaveErr(null);
    const err = await onSaveTranslation(t);
    setSavingId(null);
    if (err) setSaveErr(err);
  }

  const current = translations[0] ?? null;
  const history = translations.slice(1);

  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      <ToolSection
        title="译"
        open={open.trans}
        onToggle={() => setOpen((o) => ({ ...o, trans: !o.trans }))}
      >
        {translating && (
          <div className="mb-1.5 space-y-1.5 rounded-md bg-inset p-2.5">
            <div className="h-2.5 w-full animate-pulse rounded-sm bg-raised" />
            <div className="h-2.5 w-5/6 animate-pulse rounded-sm bg-raised" />
            <div className="h-2.5 w-2/3 animate-pulse rounded-sm bg-raised" />
          </div>
        )}
        {current && (
          <TranslationCard
            t={current}
            saving={savingId === current.id}
            onSave={() => void save(current)}
          />
        )}
        {history.length > 0 && (
          <p className="mb-0.5 mt-2.5 text-micro text-l4">本次会话译段</p>
        )}
        {history.map((t) => (
          <div
            key={t.id}
            className="group flex items-start gap-1 rounded-sm px-1 py-1 hover:bg-hover"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-micro text-l4">
                {t.kind === "paragraph" ? "段落对照" : "选段"} · 第 {t.page} 页 ·{" "}
                {t.original.replace(/\s+/g, " ").slice(0, 40)}
              </p>
              <p className="line-clamp-2 whitespace-pre-line text-xs leading-5 text-l3">
                {t.translated}
              </p>
            </div>
            <button
              type="button"
              disabled={t.saved || savingId === t.id}
              onClick={() => void save(t)}
              className={`${hoverRevealClass} shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l3 hover:bg-inset hover:text-l1 disabled:opacity-50`}
            >
              {t.saved ? "✓ 已保存" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => onRemoveTranslation(t.id)}
              className={`${hoverRevealClass} flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-micro text-l4 hover:bg-inset hover:text-l1`}
            >
              ×
            </button>
          </div>
        ))}
        {!translating && translations.length === 0 && (
          <p className="text-micro text-l4">划词点「译」，或 ⌘+点击段落。</p>
        )}
        {saveErr && <p className="mt-1 text-micro text-err-text">{saveErr}</p>}
      </ToolSection>

      <ToolSection
        title={`生词本${glossary.length > 0 ? ` ${glossary.length}` : ""}`}
        open={open.gloss}
        onToggle={() => setOpen((o) => ({ ...o, gloss: !o.gloss }))}
      >
        {glossary.length === 0 ? (
          <p className="text-micro text-l4">选中文本点「＋ 生词」加入。</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-left text-micro text-l4">
                <th className="w-[30%] pb-1 pr-1 font-normal">术语</th>
                <th className="pb-1 pr-1 font-normal">释义</th>
                <th className="w-[26%] pb-1 pr-1 font-normal">出处</th>
                <th className="w-5 pb-1" />
              </tr>
            </thead>
            <tbody>
              {glossary.map((g) => (
                <tr key={g.term} className="group align-top hover:bg-hover">
                  <td className="break-words py-1 pr-1 text-xs leading-4 text-l1">
                    {g.term}
                  </td>
                  <td className="break-words py-1 pr-1 text-xs leading-4 text-l3">
                    {g.meaning}
                  </td>
                  <td className="break-words py-1 pr-1 text-micro leading-4 text-l4">
                    {g.source}
                  </td>
                  <td className="py-1">
                    <button
                      type="button"
                      onClick={() => onRemoveGlossary(g.term)}
                      className={`${hoverRevealClass} flex h-5 w-5 items-center justify-center rounded-sm text-micro text-l4 hover:bg-inset hover:text-l1`}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </ToolSection>

      <ToolSection
        title="大纲"
        open={open.outline}
        onToggle={() => setOpen((o) => ({ ...o, outline: !o.outline }))}
      >
        {outline === null ? (
          <LoadingRows compact />
        ) : outline.length === 0 ? (
          <p className="text-micro text-l4">该 PDF 没有目录。</p>
        ) : (
          outline.map((it, i) =>
            it.page !== null ? (
              <button
                key={i}
                type="button"
                onClick={() => onJumpPage(it.page!)}
                className="flex w-full items-baseline gap-1.5 rounded-sm py-0.5 pr-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                style={{ paddingLeft: 4 + it.depth * 12 }}
              >
                <span className="min-w-0 flex-1 truncate">{it.title}</span>
                <span className="shrink-0 tabular-nums text-micro text-l4">
                  {it.page}
                </span>
              </button>
            ) : (
              <p
                key={i}
                className="truncate py-0.5 text-xs text-l4"
                style={{ paddingLeft: 4 + it.depth * 12 }}
              >
                {it.title}
              </p>
            ),
          )
        )}
      </ToolSection>
    </div>
  );
}

/** 折叠段：标题行（▸/▾ + 名称）+ 展开体；段间只靠留白（去线条化） */
function ToolSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-l3 hover:text-l1"
      >
        <span className="text-l4">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="px-3 pb-2">{children}</div>}
    </div>
  );
}

/** 当前对照卡：出处小标 + 原文（截 4 行）+ 译文 + 「保存到笔记」 */
function TranslationCard({
  t,
  saving,
  onSave,
}: {
  t: ReaderTranslation;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="rounded-md bg-inset p-2.5">
      <p className="text-micro text-l4">
        {t.kind === "paragraph" ? "段落对照" : "选段"} · 第 {t.page} 页
      </p>
      <p className="mt-1 line-clamp-4 whitespace-pre-line text-micro leading-4 text-l3">
        {t.original}
      </p>
      <p className="mt-1.5 whitespace-pre-line text-xs leading-5 text-l1">
        {t.translated}
      </p>
      <div className="mt-2">
        <button
          type="button"
          disabled={t.saved || saving}
          onClick={onSave}
          className="rounded-sm border border-field bg-strip px-2 py-1 text-xs text-l2 hover:bg-inset hover:text-l1 disabled:opacity-50"
        >
          {t.saved ? "✓ 已保存" : saving ? "保存中…" : "保存到笔记"}
        </button>
      </div>
    </div>
  );
}
