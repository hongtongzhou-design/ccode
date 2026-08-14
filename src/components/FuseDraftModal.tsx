import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadingRows } from "./PageFrame";
import type { TaskCardDto } from "../types";

/** fuse_card_into_draft 返回：AI 融合稿全文（后端已脱敏截断）+ 草稿相对路径 */
interface FuseDraftDto {
  relPath: string;
  text: string;
  sessionCount: number;
}

/**
 * 「◈ 融合进任务书」弹层（两阶段的人拍板点）：
 * 打开即调 fuse_card_into_draft 生成融合稿（范围 = 该卡名下会话 × 当前步骤，不写盘）；
 * 人在编辑区预览/修改后点「写入草稿」才经 write_task_draft 落盘。
 * AI profile 沿用设置页「提炼接力/评审沉淀」（digest 功能键），未配/失败行内中文报错可重试。
 */
export default function FuseDraftModal({
  projectPath,
  card,
  stepName,
  onClose,
  onWritten,
}: {
  projectPath: string;
  card: TaskCardDto;
  stepName: string;
  onClose: () => void;
  /** 融合稿已写入草稿文件：父级关闭弹层并重读草稿 */
  onWritten: () => void;
}) {
  const [draft, setDraft] = useState<FuseDraftDto | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  async function generate() {
    setError(null);
    setDraft(null);
    try {
      const res = await invoke<FuseDraftDto>("fuse_card_into_draft", {
        projectRoot: projectPath,
        taskId: card.id,
        stepName,
      });
      setDraft(res);
      setText(res.text);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, stepName]);

  async function confirm() {
    if (!draft || writing) return;
    setWriting(true);
    setError(null);
    try {
      await invoke("write_task_draft", {
        projectRoot: projectPath,
        stepName,
        content: text,
      });
      onWritten();
    } catch (reason) {
      setError(String(reason));
      setWriting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 ccode-fade"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[36rem] flex-col rounded-md border border-field ccode-float-surface p-5"
      >
        <h2 className="mb-1 shrink-0 text-base font-semibold text-l1">
          ◈ 融合进任务书
        </h2>
        <p className="mb-3 shrink-0 text-xs text-l3">
          把「{card.name}」的讨论结论织进「{stepName}」的任务书草稿
          {draft ? `（${draft.relPath}）` : ""}；可改后再写入。
        </p>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-field bg-canvas">
          {draft === null && !error ? (
            <div className="p-3">
              <LoadingRows compact />
            </div>
          ) : (
            <textarea
              className="h-full max-h-[38vh] min-h-40 w-full resize-none overflow-auto bg-canvas p-3 font-mono text-micro leading-5 text-l2 outline-none placeholder:text-l4"
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
            />
          )}
        </div>
        {error && (
          <div className="mt-3 flex shrink-0 items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-err-text">{error}</p>
            <button
              type="button"
              onClick={() => void generate()}
              className="shrink-0 rounded-sm px-2 py-1 text-xs text-l2 hover:bg-hover"
            >
              重试
            </button>
          </div>
        )}
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={writing}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={writing || draft === null || !text.trim()}
            onClick={() => void confirm()}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {writing ? "写入中…" : "写入草稿"}
          </button>
        </div>
      </div>
    </div>
  );
}
