import { useRef } from "react";
import { useAppStore } from "../store";
import { buildStepFlow, type StepFlowNode } from "../step-flow";
import { useHumanTasks } from "./HumanTasksList";
import type { ProjectStepDto, WorkspaceDto } from "../types";
import type { StepRunStatus } from "../step-flow";

/** 步骤内协同流程线（v3.71，聚焦视图顶部）：把这一步里人和 agent 的动作按先后排成有序节点链
 * （种子 → before 事项 → agent 执行 → during 事项 → after 事项 → 评审合并），当前节点高亮。
 *  回答三个问题：这一步谁先谁后（节点顺序）、现在轮到谁（当前节点）、轮到我时在哪操作（节点行就地）。 */
export default function StepFlow({
  projectPath,
  step,
  runStatus,
  hasBrief,
  ws,
  onSeed,
  onStart,
  onChanged,
  draft,
  agentContent,
}: {
  projectPath: string;
  step: ProjectStepDto;
  runStatus: StepRunStatus;
  /** 本步骤已有定稿简报（discuss 节点完成口径） */
  hasBrief: boolean;
  /** 本步骤绑定的活跃工作区（无 = 未开始） */
  ws: WorkspaceDto | undefined;
  /** 讨论种子点击（由卡片区已有逻辑承载：建卡 + 聊想法） */
  onSeed: (seed: string) => void;
  /** agent 节点「开始」= 打开开工确认弹层 */
  onStart: () => void;
  /** 人工事项勾选/交付后通知父级（当前步骤条等外部计数重取） */
  onChanged?: () => void;
  /** 任务书草稿（v3.72）：relPath 恒有（后端单一出处），exists = 草稿已起草 */
  draft?: { relPath: string; exists: boolean };
  /** agent 节点内嵌内容（如「预览 TASK.md」——TASK.md 是 agent 的合同，属于这个节点） */
  agentContent?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { states, error, note, busyTitle, dropHover, toggle, pickFile } =
    useHumanTasks({ projectPath, stepName: step.name, containerRef, onChanged });
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);

  /** 聊任务书（v3.72）：讨论直接服务于草稿——非只读启动（agent 要写草稿），
   *  指令约束只许新建/修改草稿这一个文件；不用卡片的只读保护（那是不动文件口径） */
  function chatDraft() {
    if (!draft) return;
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: `${step.name} · 任务书`,
      initialPrompt:
        `我们一起完善「${step.name}」这一步的任务书草稿（${draft.relPath}）。` +
        `先读它的现有内容（不存在就新建，开头写「# 任务书草稿：${step.name}」）。` +
        `我们讨论出的结论你直接整理进这个草稿文件——只允许新建/修改这一个文件，其他文件一律不要动。` +
        (seeds.length > 0 ? `可以先从这几个问题聊起：${seeds.join("；")}` : ""),
    });
    setPage("terminal");
  }

  /** 预览/编辑草稿（终端页文件预览编辑器，md 可直接改） */
  function openDraft() {
    if (!draft) return;
    setPreviewReq({
      path: `${projectPath.replace(/[\\/]+$/, "")}/${draft.relPath}`,
      name: draft.relPath.split("/").pop() ?? draft.relPath,
      root: projectPath,
    });
    setPage("terminal");
  }

  if (!states) return null;
  const flow = buildStepFlow({
    step,
    states,
    hasBrief,
    runStatus,
  });
  const seeds = step.discussionSeeds ?? [];

  function goTerminal() {
    if (!ws) return;
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: {},
      title: ws.name,
    });
    setPage("terminal");
  }

  function goReview() {
    if (!ws) return;
    setWorkspaceReviewRequest({
      worktreePath: ws.worktreePath,
      requestId: crypto.randomUUID(),
    });
    setPage("terminal");
  }

  function icon(node: StepFlowNode): { text: string; cls: string } {
    if (node.done) return { text: "✓", cls: "text-ok-text" };
    if (node.key === flow.currentKey) return { text: "●", cls: "text-cta" };
    return { text: "○", cls: "text-l4" };
  }

  function nodeActions(node: StepFlowNode) {
    const isCurrent = node.key === flow.currentKey;
    switch (node.kind) {
      case "human":
        return (
          <>
            {node.human!.target && !node.done && (
              <button
                type="button"
                disabled={busyTitle !== null}
                onClick={() => void pickFile(node.human!.title)}
                title={`选文件提交到落点 ${node.human!.target}（复制 + 登记提货单）；也可直接把文件拖到这一行`}
                className="shrink-0 rounded border border-field px-1.5 py-0.5 text-[10px] text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-50"
              >
                {busyTitle === node.human!.title ? "提交中…" : "提交产物"}
              </button>
            )}
          </>
        );
      case "agent":
        if (!isCurrent) return null;
        return runStatus === "pending" ? (
          <button
            type="button"
            onClick={onStart}
            className="shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-[10px] text-cta-text hover:brightness-110"
          >
            开始
          </button>
        ) : runStatus === "active" ? (
          <button
            type="button"
            onClick={goTerminal}
            className="shrink-0 rounded border border-field px-1.5 py-0.5 text-[10px] text-l2 hover:bg-white/5"
          >
            去终端看看
          </button>
        ) : null;
      case "review":
        if (!isCurrent || !ws) return null;
        return (
          <button
            type="button"
            onClick={goReview}
            className="shrink-0 rounded border border-cta-bd bg-cta px-2 py-0.5 text-[10px] text-cta-text hover:brightness-110"
          >
            去评审
          </button>
        );
      default:
        return null;
    }
  }

  return (
    <div ref={containerRef} className="rounded-md bg-inset px-2.5 py-2">
      <ol className="space-y-1">
        {flow.nodes.map((node) => {
          const isCurrent = node.key === flow.currentKey;
          const ic = icon(node);
          return (
            <li
              key={node.key}
              data-human-task={
                node.kind === "human" && node.human?.target
                  ? node.human.title
                  : undefined
              }
              className={`rounded px-1.5 py-1 ${
                node.kind === "human" && dropHover === node.human?.title
                  ? "bg-cta/10 outline outline-1 outline-cta-bd"
                  : isCurrent
                    ? "bg-white/5"
                    : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-4 shrink-0 text-center text-xs ${ic.cls}`}>
                  {ic.text}
                </span>
                {node.kind === "human" ? (
                  <input
                    type="checkbox"
                    className="size-3.5 shrink-0 accent-[var(--color-cta)]"
                    checked={node.done}
                    disabled={busyTitle === node.human!.title}
                    onChange={(e) =>
                      void toggle(node.human!, e.target.checked)
                    }
                    title={
                      node.done
                        ? "已完成；取消勾选回到文件检测口径"
                        : "勾选 = 人工确认完成（系统不再追问）"
                    }
                  />
                ) : null}
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${
                    node.done
                      ? "text-l3 line-through"
                      : isCurrent
                        ? "text-l1"
                        : "text-l3"
                  }`}
                >
                  {node.label}
                </span>
                {isCurrent && !node.done && (
                  <span className="shrink-0 text-[10px] text-cta">← 当前</span>
                )}
                {nodeActions(node)}
              </div>
              {/* 当前节点的引导与展开操作：种子 chips / 落点说明 */}
              {isCurrent && node.hint && (
                <p className="mt-0.5 pl-9 text-[11px] text-l4">{node.hint}</p>
              )}
              {node.kind === "agent" && agentContent && (
                <div className="mt-0.5 pl-9">{agentContent}</div>
              )}
              {node.kind === "discuss" && (
                <div className="mt-1 space-y-1.5 pl-9">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!draft}
                      onClick={chatDraft}
                      title="开终端和 Agent 一起改任务书草稿（只许它动这一个文件）"
                      className="rounded border border-cta-bd bg-cta px-2 py-0.5 text-[10px] text-cta-text hover:brightness-110 disabled:opacity-50"
                    >
                      跟 Agent 聊任务书
                    </button>
                    {draft?.exists && (
                      <button
                        type="button"
                        onClick={openDraft}
                        title="在终端页预览/直接编辑草稿"
                        className="rounded border border-field px-1.5 py-0.5 text-[10px] text-l2 hover:bg-white/5"
                      >
                        预览/编辑草稿
                      </button>
                    )}
                    {draft && (
                      <span className="text-[10px] text-l4">
                        {draft.exists
                          ? `已起草 · ${draft.relPath}`
                          : "还没起草——开聊后 Agent 会创建"}
                      </span>
                    )}
                  </div>
                  {seeds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-l4">不知道从哪聊起：</span>
                      {seeds.map((seed) => (
                        <button
                          key={seed}
                          type="button"
                          onClick={() => onSeed(seed)}
                          title="点击就这个问题开聊（自动建卡）"
                          className="rounded-full bg-strip px-2 py-0.5 text-[11px] text-l3 hover:bg-white/5 hover:text-l1"
                        >
                          {seed}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {node.kind === "human" &&
                (node.human!.guidance || node.human!.target) && (
                  <details className="mt-0.5 pl-9">
                    <summary className="cursor-pointer select-none text-[10px] text-l4 hover:text-l2">
                      怎么做 / 落点
                    </summary>
                    <div className="mt-0.5 space-y-0.5 text-[11px] leading-4 text-l3">
                      {node.human!.guidance && (
                        <p className="whitespace-pre-wrap">
                          {node.human!.guidance}
                        </p>
                      )}
                      {node.human!.target && (
                        <p className="font-mono text-l4">
                          落点：{node.human!.target}（放到这里系统会自动勾上）
                        </p>
                      )}
                    </div>
                  </details>
                )}
            </li>
          );
        })}
      </ol>
      {note && <p className="mt-1 pl-1 text-[11px] text-ok-text">{note}</p>}
      {error && <p className="mt-1 pl-1 text-[11px] text-err-text">{error}</p>}
    </div>
  );
}
