import { useRef, useState } from "react";
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
  hasDraft,
  ws,
  onSeed,
  customTopics,
  onStart,
  onChanged,
  draft,
  agentContent,
  onRestore,
  reviewConflict,
}: {
  projectPath: string;
  step: ProjectStepDto;
  runStatus: StepRunStatus;
  /** 本步骤任务书草稿已起草（discuss 节点完成口径） */
  hasDraft: boolean;
  /** 本步骤绑定的活跃工作区（无 = 未开始） */
  ws: WorkspaceDto | undefined;
  /** 讨论种子点击（由卡片区已有逻辑承载：建卡 + 聊想法） */
  onSeed: (seed: string) => void;
  /** 自定义话题 chips（任务书节点，种子之后）：该步骤已建卡的自定义话题，点击 = 续聊（同种子口径） */
  customTopics?: string[];
  /** agent 节点「开始」= 打开开工确认弹层 */
  onStart: () => void;
  /** 人工事项勾选/交付后通知父级（流程线橙点等外部计数重取） */
  onChanged?: () => void;
  /** 任务书草稿（v3.72）：relPath 恒有（后端单一出处），exists = 草稿已起草 */
  draft?: { relPath: string; exists: boolean };
  /** agent 节点内嵌内容（如「预览 TASK.md」——TASK.md 是 agent 的合同，属于这个节点） */
  agentContent?: React.ReactNode;
  /** 步骤工作区已归档时 agent 节点的主入口（替代「开始」）：恢复工作区 */
  onRestore?: () => void;
  /** 合并冲突阻塞：评审节点入口改为「去处理冲突」（直达冲突解决意图） */
  reviewConflict?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    states,
    error,
    note,
    busyTitle,
    dropHover,
    toggle,
    pickFile,
    pickSearchResults,
    registerOffer,
    registerOffered,
    dismissRegisterOffer,
  } = useHumanTasks({ projectPath, stepName: step.name, containerRef, onChanged });
  // 「＋ 自定义话题」行内输入（discuss 节点）：与种子同口径——建卡归档 + 直接写任务书草稿
  const [customOpen, setCustomOpen] = useState(false);
  const [customTopic, setCustomTopic] = useState("");
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);

  /** 聊任务书（v3.72）：讨论直接服务于草稿——非只读启动（agent 要写草稿），
   *  指令约束只许新建/修改草稿这一个文件；不用卡片的只读保护（那是不动文件口径）。
   *  开聊同时带开草稿预览（previewPath/previewRoot 交接给终端页右栏） */
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
        `讨论中没定下来的问题，记到草稿的「## 待拍板」小节。` +
        (seeds.length > 0 ? `可以先从这几个问题聊起：${seeds.join("；")}` : ""),
      // 草稿绝对路径：不存在也会在讨论中被 agent 创建，预览随后刷新即可见
      previewPath: `${projectPath.replace(/[\\/]+$/, "")}/${draft.relPath}`,
      previewRoot: projectPath,
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
    hasDraft,
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
      action: reviewConflict ? "resolve-conflict" : undefined,
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
      case "human": {
        // 落点在 papers/ 的事项（如「补充你已知的关键文献」）多出「导入检索结果」入口：
        // 从 Undermind/Consensus/Elicit 导出的 RIS/BibTeX/CSV 固定落 papers/imports/
        const papersTarget = (node.human!.target ?? "")
          .replace(/\\/g, "/")
          .startsWith("papers/");
        return (
          <>
            {node.human!.target && !node.done && (
              <button
                type="button"
                disabled={busyTitle !== null}
                onClick={() => void pickFile(node.human!.title)}
                title={`选文件提交到落点 ${node.human!.target}（复制 + 登记提货单）；也可直接把文件拖到这一行`}
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                {busyTitle === node.human!.title ? "提交中…" : "提交产物"}
              </button>
            )}
            {papersTarget && (
              <button
                type="button"
                disabled={busyTitle !== null}
                onClick={() => void pickSearchResults(node.human!.title)}
                title="分工：你在 Undermind / Scholar / Elicit 网页端做语义发现，agent 负责解析、DOI 去重、合并进筛选清单。导出 RIS/BibTeX/CSV 后点这里导入（可多选），落 papers/imports/；建议文件名带 来源-日期（如 consensus-2026-08-13.ris）"
                className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                导入检索结果
              </button>
            )}
          </>
        );
      }
      case "agent":
        // 「开始」不受当前节点门控（口径：开始始终可用，讨论种子/开始前事项只提醒不拦，
        // 与 KickoffConfirmDialog 一致）；active 时「去终端看看」同理常显
        // 工作区已归档：主入口换成「恢复工作区」（归档工作区不能再开工）
        if (runStatus === "pending" && onRestore) {
          return (
            <button
              type="button"
              onClick={onRestore}
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110"
            >
              恢复工作区
            </button>
          );
        }
        return runStatus === "pending" ? (
          <button
            type="button"
            onClick={onStart}
            className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110"
          >
            开始
          </button>
        ) : runStatus === "active" ? (
          <button
            type="button"
            onClick={goTerminal}
            className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover"
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
            className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110"
          >
            {reviewConflict ? "去处理冲突" : "去评审"}
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
              data-node-key={node.key}
              data-human-task={
                node.kind === "human" && node.human?.target
                  ? node.human.title
                  : undefined
              }
              className={`rounded-sm px-1.5 py-1 transition-colors duration-300 ${
                node.kind === "human" && dropHover === node.human?.title
                  ? "bg-cta/10 outline outline-1 outline-cta-bd"
                  : isCurrent
                    ? "bg-hover"
                    : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-4 shrink-0 text-center text-sm ${ic.cls}`}
                >
                  {ic.text}
                </span>
                {node.kind === "human" ? (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-[var(--color-cta)]"
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
                  className={`min-w-0 flex-1 truncate text-sm ${
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
                  <span className="shrink-0 text-micro text-cta">← 当前</span>
                )}
                {nodeActions(node)}
              </div>
              {/* 当前节点的引导与展开操作：种子 chips / 落点说明 */}
              {isCurrent && node.hint && (
                <p className="mt-0.5 pl-9 text-xs text-l4">{node.hint}</p>
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
                      className="rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110 disabled:opacity-50"
                    >
                      跟 Agent 聊任务书
                    </button>
                    {draft?.exists && (
                      <button
                        type="button"
                        onClick={openDraft}
                        title="在终端页预览/直接编辑草稿"
                        className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover"
                      >
                        预览/编辑草稿
                      </button>
                    )}
                    {draft?.exists && (
                      <span className="text-xs text-l4">
                        已起草 · {draft.relPath}
                      </span>
                    )}
                  </div>
                  {/* 讨论入口单一化：种子 + 自定义话题同口径（建卡归档 + 结论直接写草稿进 TASK.md）。
                      桶头不再另设「添加想法」——讨论的事全归这个节点 */}
                  <div className="flex flex-wrap items-center gap-1">
                    {seeds.map((seed) => (
                      <button
                        key={seed}
                        type="button"
                        onClick={() => onSeed(seed)}
                        title="点击就这个问题开聊（自动建卡）"
                        className="rounded-full bg-strip px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                      >
                        {seed}
                      </button>
                    ))}
                    {/* 自定义话题 = 种子同款 chip：已建卡，点击直接续聊（结论继续写进任务书草稿） */}
                    {(customTopics ?? []).map((topic) => (
                      <button
                        key={topic}
                        type="button"
                        onClick={() => onSeed(topic)}
                        title="你加过的自定义话题：点击继续聊（结论写进任务书草稿）"
                        className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                      >
                        {topic}
                      </button>
                    ))}
                    {customOpen ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const topic = customTopic.trim();
                          if (!topic) return;
                          setCustomOpen(false);
                          setCustomTopic("");
                          onSeed(topic);
                        }}
                      >
                        <input
                          autoFocus
                          value={customTopic}
                          onChange={(e) => setCustomTopic(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              setCustomOpen(false);
                              setCustomTopic("");
                            }
                          }}
                          onBlur={() => {
                            if (!customTopic.trim()) setCustomOpen(false);
                          }}
                          placeholder="话题名，回车开聊"
                          className="w-44 rounded border border-field bg-inset px-1.5 py-0.5 text-micro text-l1 outline-none placeholder:text-l4 focus:border-cta-bd"
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setCustomOpen(true)}
                        title="种子没覆盖到的话题：起名开聊，与种子同一口径——自动建卡归档，结论直接写进任务书草稿"
                        className="rounded-full border border-dashed border-field px-2 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
                      >
                        ＋ 自定义话题
                      </button>
                    )}
                  </div>
                </div>
              )}
              {node.kind === "human" &&
                (node.human!.guidance || node.human!.target) && (
                  <details className="mt-0.5 pl-9">
                    <summary className="cursor-pointer select-none text-xs text-l4 hover:text-l2">
                      怎么做 / 落点
                    </summary>
                    <div className="mt-0.5 space-y-0.5 text-xs leading-5 text-l3">
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
      {note && <p className="mt-1 pl-1 text-micro text-ok-text">{note}</p>}
      {registerOffer && (
        <p className="mt-1 flex items-center gap-1.5 pl-1 text-micro text-l3">
          要登记为项目资源吗（{registerOffer.destRel}）
          <button
            type="button"
            onClick={() => void registerOffered()}
            className="rounded-sm border border-field px-1.5 py-0.5 text-l2 hover:bg-hover hover:text-l1"
          >
            登记
          </button>
          <button
            type="button"
            onClick={dismissRegisterOffer}
            title="不登记，文件已在落点目录里"
            className="rounded-sm px-1 py-0.5 text-l4 hover:bg-hover hover:text-l1"
          >
            不了
          </button>
        </p>
      )}
      {error && <p className="mt-1 pl-1 text-micro text-err-text">{error}</p>}
    </div>
  );
}
