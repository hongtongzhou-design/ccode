import { useRef, useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { useAppStore } from "../store";
import { confirmDialog } from "./ConfirmDialog";
import { buildStepFlow, type StepFlowNode } from "../step-flow";
import {
  parseDecisions,
  recommendedAnswers,
  unansweredDecisions,
  upsertDecisions,
} from "../step-decisions";
import { useHumanTasks, RegisterOfferRow } from "./HumanTasksList";
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
  openSeeds,
  onStart,
  onChanged,
  draft,
  agentContent,
  onRestore,
  reviewConflict,
  onDraftChanged,
  discussContent,
  litSource,
  onOpenResources,
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
  /** 还没开聊过的预置话题 chips（开过的已在话题清单里，不再重复出 chip） */
  openSeeds?: string[];
  /** agent 节点「开始」= 打开开工确认弹层 */
  onStart: () => void;
  /** 人工事项勾选/交付后通知父级（流程线橙点等外部计数重取） */
  onChanged?: () => void;
  /** 任务书草稿（v3.72）：relPath 恒有（后端单一出处），exists = 草稿已起草，
   *  text = 草稿正文（决策项答案就存在它的「已定方向」小节里，用来回填选中态） */
  draft?: { relPath: string; exists: boolean; text?: string | null };
  /** 决策项落盘后通知父级重读草稿（与「◈ 沉淀进任务书」同一回调） */
  onDraftChanged?: () => void;
  /** discuss 节点内嵌内容（想法区）：讨论的事全归这个节点，不在流程线外另立并列区块 */
  discussContent?: React.ReactNode;
  /** 项目的文献来源（project.toml lit_source）：zotero/folder 时，落点在 papers/ 的人工事项
   *  不该再劝人往 papers/ 里塞 PDF——那会造出第二个文献存放处，与已有库各自漂移 */
  litSource?: string;
  /** 展开项目的「文献与数据」面板：文献类交付统一引到那里，不在每个事项行复制入口 */
  onOpenResources?: () => void;
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
    registerOffer,
    registerOffered,
    dismissRegisterOffer,
  } = useHumanTasks({ projectPath, stepName: step.name, containerRef, onChanged });
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setPage = useAppStore((s) => s.setPage);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);

  /** 已经有文献库的项目：落点在 papers/ 的事项不该再劝人把 PDF 往项目里塞——
   *  文献的唯一出处是那个库，往 papers/ 另放一份之后两边各自漂移。
   *  只影响文案与按钮，不改事项本身的完成口径（落点检测照旧） */
  const hasLibrary = litSource === "zotero" || litSource === "folder";
  /** 落点在 papers/ 的事项 = 文献类交付，统一引到「文献与数据」 */
  const isPapersTarget = (target: string | undefined) =>
    (target ?? "").replace(/\\/g, "/").startsWith("papers/");
  /** agent 已经产出了东西（待评审或已合并）：after 档事项到这时才有的做 */
  const agentProduced = runStatus === "review" || runStatus === "done";

  // ===== 决策项（可枚举的拍板点）：点一下就答完，不开会话 =====
  // 答案存在草稿的「已定方向」小节里（草稿是开工合同，不另立一份状态），选中态由它回填
  const decisions = step.decisions ?? [];
  const answered = parseDecisions(draft?.text ?? "");
  const pendingDecisions = unansweredDecisions(decisions, answered);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // 「自己写」行内输入：选项不合适时多半只是想填一句自己的答案，
  // 为这个开终端太贵——真要展开讨论才走「开聊」
  const [writeOwn, setWriteOwn] = useState<{ q: string; text: string } | null>(
    null,
  );
  // 草稿弹层的呈现方式：编辑（textarea，主用途）/ 预览（渲染 markdown，长草稿好读）
  const [draftPreview, setDraftPreview] = useState(false);

  /** 落盘一批答案：读-改-写整份草稿（write_task_draft 是整份覆盖），
   *  批量入参让「全部用推荐值」只写一次，也少一次与 agent 并发改草稿的窗口 */
  async function commitDecisions(answers: { q: string; answer: string }[]) {
    if (answers.length === 0 || decisionBusy) return;
    setDecisionBusy(true);
    setDecisionError(null);
    try {
      // 以磁盘上的最新草稿为基（agent 可能刚改过），不拿组件里可能过期的那份
      const cur = await invoke<{ relPath: string; text: string | null }>(
        "read_task_draft",
        { projectRoot: projectPath, stepName: step.name },
      );
      await invoke("write_task_draft", {
        projectRoot: projectPath,
        stepName: step.name,
        content: upsertDecisions(cur?.text ?? "", answers),
      });
      onDraftChanged?.();
    } catch (reason) {
      setDecisionError(String(reason));
    } finally {
      setDecisionBusy(false);
    }
  }

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
  /** 草稿就地编辑（本页弹层）：草稿是开工合同，改它是高频动作，
   *  为此跳到终端页再切回来太贵。仍保留「在终端里打开」作为逃生口（要看 diff/用编辑器时） */
  const [draftEdit, setDraftEdit] = useState<{
    /** 打开时从磁盘读到的原文，用来判断是否有未保存改动 */
    origin: string;
    text: string;
    saving: boolean;
    error: string | null;
  } | null>(null);
  // 渲染在 draftEdit 声明之后：useMemo 读它，提前声明会踩 TDZ
  const draftHtml = useMemo(
    () =>
      draftEdit?.text
        ? marked.parse(draftEdit.text, {
            gfm: true,
            breaks: false,
            async: false,
          })
        : "",
    [draftEdit?.text],
  );

  async function openDraftInline() {
    setDraftEdit({ origin: "", text: "", saving: false, error: null });
    try {
      // 以磁盘最新为准：agent 可能刚改过草稿
      const cur = await invoke<{ relPath: string; text: string | null }>(
        "read_task_draft",
        { projectRoot: projectPath, stepName: step.name },
      );
      const text = cur?.text ?? "";
      setDraftEdit({ origin: text, text, saving: false, error: null });
    } catch (reason) {
      setDraftEdit({
        origin: "",
        text: "",
        saving: false,
        error: String(reason),
      });
    }
  }

  async function saveDraftInline() {
    if (!draftEdit || draftEdit.saving) return;
    setDraftEdit({ ...draftEdit, saving: true, error: null });
    try {
      await invoke("write_task_draft", {
        projectRoot: projectPath,
        stepName: step.name,
        content: draftEdit.text,
      });
      setDraftEdit(null);
      onDraftChanged?.();
    } catch (reason) {
      setDraftEdit((s) =>
        s ? { ...s, saving: false, error: String(reason) } : s,
      );
    }
  }

  /** 关闭前守一道：有未保存改动时确认，避免误点背景丢掉手写的内容 */
  async function closeDraftInline() {
    if (!draftEdit) return;
    if (
      draftEdit.text !== draftEdit.origin &&
      !(await confirmDialog("草稿有未保存的改动，确定放弃？", {
        danger: true,
        confirmText: "放弃改动",
      }))
    )
      return;
    setDraftEdit(null);
  }

  /** Esc 关闭草稿弹层（与 DigestPicker 同口径；有未保存改动时走同一道确认） */
  useEffect(() => {
    if (!draftEdit) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void closeDraftInline();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftEdit?.text, draftEdit?.origin]);

  /** 在终端页打开草稿（原行为，保留为逃生口） */
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
    pendingDecisions: pendingDecisions.length,
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

  /** 节点圆点：同一族形状，靠「空心 → 实心」表达进度，不引入第二种字形。
   *  原来完成态用绿 ✓——勾号在一列圆点里是异类，而且 ok-text 的亮绿在暗色主题下发飘。
   *  改用实心圆 + done 色（与上方大圆步进器的 bg-done 同一枚绿），全站一套语言；
   *  「已完成」的语义还有标题的删除线与降级色兜着，不靠图标独扛 */
  function icon(node: StepFlowNode): { text: string; cls: string } {
    if (node.done) return { text: "●", cls: "text-done" };
    if (node.key === flow.currentKey) return { text: "●", cls: "text-cta" };
    return { text: "○", cls: "text-l4" };
  }

  function nodeActions(node: StepFlowNode) {
    const isCurrent = node.key === flow.currentKey;
    switch (node.kind) {
      case "human": {
        const papersTarget = isPapersTarget(node.human!.target);
        // after 档事项依赖 agent 的产出才知道要做什么（付费墙清单是 agent 筛完才列出来的）。
        // agent 没跑完就摆出操作入口 = 提前噪音；节点仍然显示，让人知道后面有这一步
        // after 档且 agent 还没产出：不给操作入口，也不写一句「等 agent」——
        // 节点排在 agent 之后，先后顺序看位置就知道了，多一句话是噪音。
        // 「还轮不到」由整行降透明度表达（见下方 li 的 dimmed）
        if (node.human!.timing === "after" && !agentProduced) return null;
        // 文献类交付统一去「文献与数据」：那里三个进料口齐全（Zotero / 题录 / 扫目录），
        // 在每个事项行再复制一套入口，等于把同一件事摆三个地方
        if (papersTarget) {
          return node.done ? null : (
            <button
              type="button"
              onClick={onOpenResources}
              title={
                hasLibrary
                  ? "新文献加进你的文献库后，到「文献与数据」重新导入即可——不必往项目里另放一份"
                  : "到「文献与数据」导入：可从 Zotero 导入、导入 RIS/BibTeX 题录，或把文件放进项目目录后重新扫描"
              }
              className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1"
            >
              到「文献与数据」导入
            </button>
          );
        }
        // 非文献类交付（学校格式规范、审稿意见原文等）保留直接提交
        return node.human!.target && !node.done ? (
          <button
            type="button"
            disabled={busyTitle !== null}
            onClick={() => void pickFile(node.human!.title)}
            title={`选文件提交到落点 ${node.human!.target}；也可直接把文件拖到这一行`}
            className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
          >
            {busyTitle === node.human!.title ? "提交中…" : "提交产物"}
          </button>
        ) : null;
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

  /** 单个节点行（主干与可选区共用）：dense = 可选区的紧凑版（更小字号、不显示 hint） */
  function renderNode(node: StepFlowNode, dense = false) {
    const isCurrent = node.key === flow.currentKey;
    const ic = icon(node);
    return (
      <li
        key={node.key}
        data-node-key={node.key}
        title={
          node.kind === "human" && node.human!.guidance && (dense || !isCurrent)
            ? node.human!.guidance
            : undefined
        }
        data-human-task={
          node.kind === "human" && node.human?.target
            ? node.human.title
            : undefined
        }
        className={`rounded-sm py-1 pr-1.5 transition-colors duration-300 ${
          node.kind === "human" && dropHover === node.human?.title
            ? "bg-cta/10 outline outline-1 outline-cta-bd pl-1.5"
            : isCurrent
              ? // 当前节点只在左侧立一道竖线，不给整块刷底色：
                // 「定方向」内容高，整块 bg-hover 会变成一大片色板，把主动作「开始」压下去
                "border-l-2 border-cta pl-1"
              : "pl-1.5 border-l-2 border-transparent"
        } ${
          // 还轮不到（after 档且 agent 未产出）：整行压暗，不写「等 agent」那种话
          node.kind === "human" &&
          node.human!.timing === "after" &&
          !agentProduced &&
          !node.done
            ? "opacity-45"
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
            className={`min-w-0 flex-1 truncate ${
              dense ? "text-xs" : "text-sm"
            } ${
              node.done
                ? "text-l4 line-through"
                : isCurrent
                  ? "text-l1"
                  : dense
                    ? "text-l3"
                    : "text-l2"
            }`}
          >
            {node.label}
          </span>
          {/* 可选事项标记：不做也不影响这一步跑完。没有这个标记的话，
              一个永远不打勾的条目看起来就像没做完的必办项 */}
          {!dense && node.kind === "human" && node.human!.optional && !node.done && (
            <span
              className="shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-micro text-l4"
              title="可选：不做也能跑完这一步"
            >
              可选
            </span>
          )}
          {isCurrent && !node.done && (
            <span className="shrink-0 text-micro text-cta">← 当前</span>
          )}
          {nodeActions(node)}
        </div>
        {/* 当前节点的引导与展开操作：种子 chips / 落点说明 */}
        {!dense && isCurrent && node.hint && (
          <p className="mt-0.5 pl-9 text-micro text-l4">{node.hint}</p>
        )}
        {node.kind === "agent" && agentContent && (
          <div className="mt-0.5 pl-9">{agentContent}</div>
        )}
        {node.kind === "discuss" && (
          <div className="mt-1 space-y-1.5 pl-9">
            {/* 决策项：可枚举的拍板点一行一题，点选即答——不开终端、不建卡、不切页。
                真正开放的问题才留给下面的种子 chips 去聊 */}
            {decisions.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-micro text-l4">
                    {pendingDecisions.length > 0
                      ? `要拍板的 ${pendingDecisions.length} 件事`
                      : `${decisions.length} 件都已拍板`}
                  </span>
                  {pendingDecisions.length > 0 && (
                    <button
                      type="button"
                      disabled={decisionBusy}
                      onClick={() =>
                        void commitDecisions(
                          recommendedAnswers(decisions, answered),
                        )
                      }
                      title="未拍板的一律取第一个选项（推荐值）写进草稿；已选过的不动"
                      className="ml-auto shrink-0 rounded-sm px-1 py-0.5 text-micro text-l4 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l2 disabled:opacity-50"
                    >
                      全部用推荐值
                    </button>
                  )}
                </div>
                {decisions.map((d) => {
                  const picked = answered.get(d.q.trim());
                  return (
                    <div
                      key={d.q}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1"
                    >
                      <span
                        className={`shrink-0 text-xs ${picked ? "text-l3" : "text-l1"}`}
                      >
                        {d.q}
                      </span>
                      {d.options.map((opt) => {
                        const on = picked === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={decisionBusy}
                            onClick={() =>
                              void commitDecisions([
                                { q: d.q, answer: opt },
                              ])
                            }
                            title={
                              on
                                ? "已选：写在草稿「已定方向」里，点别的选项可改"
                                : `选它：直接写进草稿「已定方向」，不开会话`
                            }
                            className={`rounded-full px-2 py-0.5 text-micro disabled:opacity-50 ${
                              on
                                ? "border border-cta-bd bg-cta text-cta-text"
                                : "bg-strip text-l3 hover:bg-hover hover:text-l1"
                            }`}
                          >
                            {opt}
                          </button>
                        );
                      })}
                      {/* 自己写的答案不在选项里：单独显示成同款选中 chip，
                          否则填完看不到任何选中态，像是没生效 */}
                      {picked && !d.options.includes(picked) && (
                        <button
                          type="button"
                          onClick={() =>
                            setWriteOwn({ q: d.q, text: picked })
                          }
                          title="你自己写的答案，点击可改"
                          className="rounded-full border border-cta-bd bg-cta px-2 py-0.5 text-micro text-cta-text hover:brightness-110"
                        >
                          {picked}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setWriteOwn(
                            writeOwn?.q === d.q
                              ? null
                              : { q: d.q, text: picked ?? "" },
                          )
                        }
                        title="选项都不合适：自己写一句，或展开去聊"
                        className="shrink-0 rounded-sm px-1 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l1"
                      >
                        其他…
                      </button>
                    </div>
                  );
                })}
                {/* 自己写：写完直接进草稿，和点选项同一条路径，不开终端 */}
                {writeOwn && (
                  <form
                    className="flex items-center gap-1.5 pt-0.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const answer = writeOwn.text.trim();
                      if (!answer) return;
                      void commitDecisions([
                        { q: writeOwn.q, answer },
                      ]).then(() => setWriteOwn(null));
                    }}
                  >
                    <span className="shrink-0 text-micro text-l4">
                      {writeOwn.q}
                    </span>
                    <input
                      autoFocus
                      value={writeOwn.text}
                      onChange={(e) =>
                        setWriteOwn({ ...writeOwn, text: e.target.value })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setWriteOwn(null);
                      }}
                      placeholder="自己写一句，回车写进草稿"
                      className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-micro text-l1 outline-none focus:border-cta-bd"
                    />
                    <button
                      type="submit"
                      disabled={decisionBusy || !writeOwn.text.trim()}
                      className="shrink-0 rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-micro text-cta-text hover:brightness-110 disabled:opacity-50"
                    >
                      记下
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const q = writeOwn.q;
                        setWriteOwn(null);
                        onSeed(q);
                      }}
                      title="拿不准？就这个问题开终端和 Agent 聊（自动建卡，结论写进草稿）"
                      className="shrink-0 rounded-sm px-1.5 py-0.5 text-micro text-l4 hover:bg-hover hover:text-l2"
                    >
                      开聊
                    </button>
                  </form>
                )}
                {decisionError && (
                  <p className="text-micro text-err-text">
                    {decisionError}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!draft}
                onClick={chatDraft}
                title="开终端和 Agent 一起改任务书草稿（只许它动这一个文件）"
                className="rounded-sm border border-field px-1.5 py-0.5 text-micro text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                跟 Agent 聊任务书
              </button>
              {draft?.exists && (
                <button
                  type="button"
                  onClick={() => void openDraftInline()}
                  title="就地查看/编辑草稿，不跳页"
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
            {/* 预置话题 chips：只列还没开聊过的——开过的已经以话题行躺在下面的清单里，
                两处都显示会让人以为是两个东西。点击 = 只读开聊（同话题清单口径），
                「让 agent 直接改草稿」是上面那颗「跟 Agent 聊任务书」的活，两者不重叠 */}
            {(openSeeds ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {(openSeeds ?? []).map((seed) => (
                  <button
                    key={seed}
                    type="button"
                    onClick={() => onSeed(seed)}
                    title="就这个问题开聊：只读讨论不动文件，聊完可「◈ 沉淀进任务书」"
                    className="rounded-full bg-strip px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                  >
                    {seed}
                  </button>
                ))}
              </div>
            )}
            {/* 想法区（v3.80）：自由想法卡，讨论的最松散一档，排在种子之后。
                由卡片区经 discussContent 传入——与 agentContent 同一范式，
                收进本节点是为了让「一步 = 一条线」，不在流程线旁边另立并列区块 */}
            {discussContent}
          </div>
        )}
        {/* 说明常显、不再折叠：按钮收走之后行里本来就空，把唯一有信息量的
            一句话藏进「怎么做 / 落点」等于既占地方又没人看。
            只显示 guidance（真正的人机分工说明）；落点路径是实现细节，
            拖拽/导入都不需要用户知道它，不再单列一行 */}
        {/* 说明只在当前节点显示：一屏同时摊开五段说明是这一页最大的噪音源。
            非当前节点的说明挂在行的 title 上（悬停可见），信息不丢 */}
        {!dense && isCurrent && node.kind === "human" && node.human!.guidance && (
          <p className="mt-0.5 whitespace-pre-wrap pl-9 text-micro leading-5 text-l4">
            {node.human!.guidance}
          </p>
        )}
      </li>
    );
  }

  return (
    <div ref={containerRef} className="rounded-md bg-inset px-2.5 py-2">
      <ol className="space-y-1">
        {flow.nodes
          .filter((n) => n.section === "main")
          .map((node) => renderNode(node, false))}
      </ol>
      {/* 可选补充：沉到分隔线下，与主干拉开层级——它们不做也能跑完这一步，
          和「定方向 / agent 执行 / 评审」平铺在一起会让人以为样样都得做 */}
      {flow.nodes.some((n) => n.section === "optional") && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-micro text-l4">可选（不做也能跑）</span>
            <span className="h-px min-w-0 flex-1 bg-hairline" />
          </div>
          <ol className="mt-1 space-y-0.5">
            {flow.nodes
              .filter((n) => n.section === "optional")
              .map((node) => renderNode(node, false))}
          </ol>
        </>
      )}
      {note && <p className="mt-1 pl-1 text-micro text-ok-text">{note}</p>}
      {registerOffer && (
        <RegisterOfferRow
          destRels={registerOffer.destRels}
          onRegister={() => void registerOffered()}
          onDismiss={dismissRegisterOffer}
          className="pl-1"
        />
      )}
      {error && <p className="mt-1 pl-1 text-micro text-err-text">{error}</p>}
      {/* 草稿就地编辑弹层：不跳终端页。背景点击在有未保存改动时会先确认 */}
      {draftEdit && (
        <div
          className="ccode-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => void closeDraftInline()}
        >
          <div
            className="ccode-float-surface flex h-[70vh] w-full max-w-2xl flex-col rounded-md border border-field p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex shrink-0 items-baseline gap-2">
              <h2 className="shrink-0 text-base font-semibold text-l1">
                任务书草稿：{step.name}
              </h2>
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-l4">
                {draft?.relPath}
              </span>
              <button
                type="button"
                onClick={() => setDraftPreview((v) => !v)}
                title={
                  draftPreview ? "回到编辑" : "看渲染后的排版（长草稿好读）"
                }
                className="shrink-0 self-center rounded-sm border border-field px-1.5 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                {draftPreview ? "编辑" : "预览"}
              </button>
            </div>
            {draftPreview ? (
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
                <div
                  className="md-body px-4 py-3"
                  dangerouslySetInnerHTML={{ __html: draftHtml }}
                />
              </div>
            ) : (
              <textarea
                value={draftEdit.text}
                onChange={(e) =>
                  setDraftEdit((s) => (s ? { ...s, text: e.target.value } : s))
                }
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-md border border-field bg-canvas p-3 font-mono text-micro leading-5 text-l2 outline-none focus:border-cta-bd"
              />
            )}
            <p className="mt-2 shrink-0 text-micro text-l4">
              草稿就是开工时的 TASK.md 来源；「已定方向」小节由上方选项自动维护，手改也生效
            </p>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftEdit(null);
                  openDraft();
                }}
                title="改用终端页打开（要看改动对比或用编辑器时）"
                className="rounded-sm px-2 py-1.5 text-micro text-l4 hover:bg-hover hover:text-l2"
              >
                在终端里打开
              </button>
              {draftEdit.error && (
                <span className="min-w-0 flex-1 truncate text-micro text-err-text">
                  {draftEdit.error}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void closeDraftInline()}
                  className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={
                    draftEdit.saving || draftEdit.text === draftEdit.origin
                  }
                  onClick={() => void saveDraftInline()}
                  title={
                    draftEdit.text === draftEdit.origin
                      ? "没有改动"
                      : "写回草稿文件"
                  }
                  className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {draftEdit.saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
