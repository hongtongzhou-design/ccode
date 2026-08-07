import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

/** ai_distill_skill 的返回（SKILL.md frontmatter name/description + 正文规则清单） */
interface SkillDraftDto {
  name: string;
  description: string;
  content: string;
}

/** 「✦ 沉淀为技能」：把当前选段交给 AI 提炼成技能草稿 → 跳技能页新建 modal 预填。
 *  与浮动条其余按钮同风格；提炼期间禁用，失败经 onHint 行内提示（调用方各自的 hint 机制）。 */
export function DistillSkillButton({
  onHint,
}: {
  onHint: (msg: string) => void;
}) {
  const setSkillDraftReq = useAppStore((s) => s.setSkillDraftReq);
  const setPage = useAppStore((s) => s.setPage);
  const [distilling, setDistilling] = useState(false);

  async function distill() {
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (!selected || distilling) return;
    setDistilling(true);
    try {
      const draft = await invoke<SkillDraftDto>("ai_distill_skill", {
        excerpt: selected,
      });
      setSkillDraftReq(draft);
      setPage("skills");
      // 清选区让浮动条随 selectionchange 收起（同其余按钮的收尾）
      window.getSelection()?.removeAllRanges();
    } catch (e) {
      onHint(`提炼技能草稿失败：${e}`);
    } finally {
      setDistilling(false);
    }
  }

  return (
    <button
      type="button"
      // preventDefault 保住选区，click 时才读文字
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void distill()}
      disabled={distilling}
      className="rounded border border-cta-bd bg-cta px-2 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-60"
    >
      {distilling ? "提炼中…" : "✦ 沉淀为技能"}
    </button>
  );
}

/**
 * 选区浮动动作条（PDF「◈ 问 AI」与 md 阅读「◈ 讨论/改写此段」共用）：
 * 容器内选中文字 → 跟随选区末端下方显示按钮条；失选/收起即消失。
 * 按钮由调用方作为 children 渲染，须用 onMouseDown preventDefault 保住选区，
 * click 时再经 window.getSelection() 读取选段文本。
 */
export default function SelectionFloatBar({
  containerRef,
  withinSelector,
  reserveWidth = 170,
  children,
}: {
  /** 相对定位的滚动容器；选区锚点必须落在其中，按钮相对它绝对定位 */
  containerRef: RefObject<HTMLElement | null>;
  /** 选区锚点还必须命中的后代选择器（PDF 的 [data-page-num]、md 的 .md-body），
      防止终端等其他区域的选区误触发本条 */
  withinSelector: string;
  /** 右缘预留宽度（约等于按钮条总宽），避免溢出容器右缘 */
  reserveWidth?: number;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // 选区监听：容器内选中文字 → 跟随选区末端定位；失选/收起即隐藏。
  // 点击按钮后调用方 removeAllRanges 清选区，selectionchange 会自然把本条收掉
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      const scroll = containerRef.current;
      if (!sel || sel.isCollapsed || !scroll) {
        setPos(null);
        return;
      }
      const node = sel.anchorNode;
      const el =
        node?.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node?.parentElement;
      if (!el || !scroll.contains(el) || !el.closest(withinSelector)) {
        setPos(null);
        return;
      }
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const sr = scroll.getBoundingClientRect();
      setPos({
        x: Math.max(
          8,
          Math.min(
            r.right - sr.left + scroll.scrollLeft - 72,
            sr.width - reserveWidth,
          ),
        ),
        y: r.bottom - sr.top + scroll.scrollTop + 6,
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, [containerRef, withinSelector, reserveWidth]);

  if (!pos) return null;
  return (
    <div
      style={{ left: pos.x, top: pos.y }}
      className="absolute z-10 flex gap-1"
    >
      {children}
    </div>
  );
}
