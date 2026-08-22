import { useRef, useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import { renderMathInto } from "../md-math";
import { useAppStore } from "../store";
import { confirmDialog } from "./ConfirmDialog";
import { buildStepFlow, type StepFlowNode } from "../step-flow";
import {
  parseDecisions,
  isDecisionsOnly,
  recommendedAnswers,
  unansweredDecisions,
  upsertDecisions,
} from "../step-decisions";
import { useHumanTasks, RegisterOfferRow } from "./HumanTasksList";
import { buildWorkspaceTerminalRequest } from "../pipeline-start";
import type { ProjectStepDto, WorkspaceDto } from "../types";
import type { StepRunStatus } from "../step-flow";

/** 步骤内协同流程线（v3.71，聚焦视图顶部）：把这一步里人和 agent 的动作按先后排成有序节点链
 * （种子 → before 事项 → agent 执行 → during 事项 → after 事项 → 评审合并），当前节点高亮。
 *  回答三个问题：这一步谁先谁后（节点顺序）、现在轮到谁（当前节点）、轮到我时在哪操作（节点行就地）。 */
/** 文献来源选项（值与后端 lit_source 对应）：zotero 与 folder 都属「我已有文献库」，
 *  区别只在进料方式，故并列三项而不是嵌套两层 */
const LIT_SOURCES: {
  id: string;
  label: string;
  hint: string;
  /** 选完之后要做的事（链接文案）；null = 不需要准备什么 */
  action: string | null;
  /** 落点聚焦：到「文献与数据」后高亮哪个入口 */
  focus?: "zotero" | "files";
}[] = [
  {
    id: "search",
    label: "让 agent 检索",
    hint: "不用准备，开工即检索。",
    action: "去补几篇 →",
    focus: "files",
  },
  {
    id: "zotero",
    label: "我有 Zotero 库",
    hint: "读你的 Zotero 库；文献留在原处不搬走。",
    action: "去导入 Zotero 库 →",
    focus: "zotero",
  },
  {
    id: "folder",
    label: "我有一堆 PDF / 题录",
    hint: "把题录或 PDF 放进项目，开工时自动解析。",
    action: "去放入题录 / PDF →",
    focus: "files",
  },
];

function guidancePreview(text: string): string {
  const full = text.trim();
  const firstParagraph = full.split(/\n\s*\n/)[0]?.trim() ?? full;
  if (firstParagraph.length <= 120) return firstParagraph;
  const sentence = firstParagraph.match(/^.*?[。！？!?]/)?.[0]?.trim();
  return sentence && sentence.length <= 120
    ? sentence
    : `${firstParagraph.slice(0, 117).trimEnd()}…`;
}

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
  onSeedDraft,
  onLoadTaskMd,
  discussContent,
  litSource,
  onOpenResources,
  onSetLitSource,
  litBusy = false,
  bare = false,
  agentAttention = null,
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
  /** 「跟 AI 商量一下」开聊前的播种（v3.90）：空内容先灌模板拼装，由卡片区实现（它有 cfg 与拼装出处） */
  onSeedDraft?: () => Promise<void>;
  /** 「预览/编辑 TASK.md」的统一加载（v3.90）：返回展示内容——已有编辑内容读文件全文，
   *  否则给模板拼装（只读展示不落盘，保存才落地）。由卡片区实现（它有 cfg 与拼装出处） */
  onLoadTaskMd?: () => Promise<string>;
  /** discuss 节点内嵌内容（想法区）：讨论的事全归这个节点，不在流程线外另立并列区块 */
  discussContent?: React.ReactNode;
  /** 项目的文献来源（project.toml lit_source）：zotero/folder 时，落点在 papers/ 的人工事项
   *  不该再劝人往 papers/ 里塞 PDF——那会造出第二个文献存放处，与已有库各自漂移 */
  litSource?: string;
  /** 展开项目的「文献与数据」面板：文献类交付统一引到那里，不在每个事项行复制入口。
   *  focus = 落地后高亮哪个进料入口（按所选文献来源给） */
  onOpenResources?: (focus?: "zotero" | "files") => void;
  /** 输入准备（v3.86，仅 step.asksLitSource 为真的步骤渲染）：文献来源选择 + 就地导入。
   *  与决策项分属两类——决策项写草稿、纯记录；这里写 config.lit_source 且带动作 */
  onSetLitSource?: (value: string) => void | Promise<void>;
  litBusy?: boolean;
  /** 嵌在「当前步骤卡」里时去掉自带的底色与内边距，由外层卡片统一承载（v3.85 三段式） */
  bare?: boolean;
  /** agent 节点内嵌内容（如「预览 TASK.md」——TASK.md 是 agent 的合同，属于这个节点） */
  agentContent?: React.ReactNode;
  /** 步骤工作区已归档时 agent 节点的主入口（替代「开始」）：恢复工作区 */
  onRestore?: () => void;
  /** 合并冲突阻塞：评审节点入口改为「去处理冲突」（直达冲突解决意图） */
  reviewConflict?: boolean;
  /** 本步骤工作区内终端的注意力（ProjectGroup stepAttention 同一口径）：
   *  done = agent 跑完在等你——active 态的「去终端看看」旁给出完成提示 */
  agentAttention?: "confirm" | "done" | null;
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
  /** agent 已经产出了东西（待评审或已合并）：after 档事项到这时才有的做。
   *  v3.97 放宽（用户实测：agent 跑完但没提交时步骤停在「进行中」，入口永远不出现）——
   *  单个 after 事项的就绪口径见 afterReady()：会话尾部判定 done（agent 跑完在等你）、
   *  或该事项的待获取清单已现算到（to-fetch.md 存在 = agent 已列出要补什么） */
  const agentProduced = runStatus === "review" || runStatus === "done";
  const afterReady = (h: { expectedCount?: number }) =>
    agentProduced || agentAttention === "done" || h.expectedCount != null;

  // ===== 决策项（可枚举的拍板点）：点一下就答完，不开会话 =====
  // 答案存在草稿的「已定方向」小节里（草稿是开工合同，不另立一份状态），选中态由它回填
  const decisions = step.decisions ?? [];
  const answered = parseDecisions(draft?.text ?? "");
  /** 已有编辑内容（v3.90：UI 不再暴露「草稿」概念）= 文件有正文；
      仅含「已定方向」答案的不算——那只是点选记录，不是编辑过的 TASK.md */
  const draftHasBody =
    !!draft?.text?.trim() && !isDecisionsOnly(draft.text ?? "");
  const pendingDecisions = unansweredDecisions(decisions, answered);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // 「自己写」行内输入：选项不合适时多半只是想填一句自己的答案，
  // 为这个开终端太贵——真要展开讨论才走「开聊」
  // 决策项折叠态（v3.89）：默认收起——它们不拦开工，摊开像必办清单
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  // 方式二折叠态（v3.90）：与方式一同款——默认收起一行，展开才露「跟 AI 商量一下」
  const [chatOpen, setChatOpen] = useState(false);
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

  /** 聊任务书（v3.72）：讨论直接服务于 TASK.md 内容文件——非只读启动（agent 要写文件），
   *  指令约束只许新建/修改这一个文件；不用卡片的只读保护（那是不动文件口径）。
   *  开聊同时带开文件预览（previewPath/previewRoot 交接给终端页右栏）。
   *  v3.90 起先播种（onSeedDraft）：空文件/仅决策答案的文件先灌入模板拼装——
   *  商量改的就是最终落盘的 TASK.md，从零起草会把简报/预期产物/提货单全丢掉 */
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  async function chatDraft() {
    if (!draft || chatBusy) return;
    setChatBusy(true);
    setChatError(null);
    try {
      await onSeedDraft?.();
    } catch (reason) {
      setChatBusy(false);
      setChatError(`TASK.md 准备失败：${String(reason)}`);
      return;
    }
    setChatBusy(false);
    // 步骤认领不在此登记：启动栏还可能改 agent/目录，改由终端页 spawn 时以最终值登记
    // （pendingTerminal.stepName → TerminalView launch 时 invoke claim_next_session_for_step）。
    // 它跑在项目根（只改 TASK.md，不落步骤工作区），不登记的话 stepName 为空，
    // 「本步骤的对话」捞不到它。
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: `${step.name} · 任务书`,
      stepName: step.name,
      initialPrompt:
        `我们一起敲定「${step.name}」这一步的任务书（${draft.relPath}）。` +
        `它现在的内容就是 TASK.md 的默认拼装（步骤简报、预期产物等都在里面），定稿后会原样落成工作区的 TASK.md。` +
        `先通读一遍，把拿不准的点（范围、口径、标准等）逐个问我，按我的回答直接修改这份文件。` +
        `只允许新建/修改这一个文件，其他文件一律不要动。` +
        `讨论中没定下来的问题，记到这份任务书的「## 待拍板」小节。` +
        (seeds.length > 0 ? `可以先从这几个问题聊起：${seeds.join("；")}` : ""),
      // 文件绝对路径：播种后已存在；播种失败已在上面拦截，不会走到这里
      previewPath: `${projectPath.replace(/[\\/]+$/, "")}/${draft.relPath}`,
      previewRoot: projectPath,
      // 同一步骤的任务书讨论是同一个对话：再点「跟 AI 商量一下」切回已有标签
      reuseKey: `discuss:${projectPath}:${draft.relPath}`,
    });
    setPage("terminal");
  }

  /** TASK.md 就地预览/编辑（本页弹层，v3.90 起与「预览 TASK.md」入口合一——不再有「草稿」概念）：
   *  内容经 onLoadTaskMd 加载：已有编辑内容读文件，否则给模板拼装（只读展示不落盘，纯看不留痕，
   *  discuss 节点完成口径不受影响）；保存才经 write_task_draft 落地。
   *  仍保留「在终端里打开」作为逃生口（要看 diff/用编辑器时） */
  const [draftEdit, setDraftEdit] = useState<{
    /** 打开时读到的原文，用来判断是否有未保存改动 */
    origin: string;
    text: string;
    /** true = 还没有编辑内容，显示的是模板拼装（保存才创建文件）；「在终端里打开」此时无文件可开 */
    fromTemplate: boolean;
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
  // TASK.md 预览的公式升级（与文件预览阅读版式同一口径；无公式不加载 katex）
  const draftHtmlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (draftHtmlRef.current) void renderMathInto(draftHtmlRef.current);
  }, [draftHtml]);

  async function openDraftInline() {
    setDraftEdit({ origin: "", text: "", fromTemplate: false, saving: false, error: null });
    try {
      if (onLoadTaskMd) {
        const text = await onLoadTaskMd();
        setDraftEdit({
          origin: text,
          text,
          fromTemplate: !draftHasBody,
          saving: false,
          error: null,
        });
        return;
      }
      // 无加载回调的兜底（StepFlow 目前仅卡片区使用，正常不会走到）
      const cur = await invoke<{ relPath: string; text: string | null }>(
        "read_task_draft",
        { projectRoot: projectPath, stepName: step.name },
      );
      const text = cur?.text ?? "";
      setDraftEdit({ origin: text, text, fromTemplate: !text.trim(), saving: false, error: null });
    } catch (reason) {
      setDraftEdit({
        origin: "",
        text: "",
        fromTemplate: false,
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
      !(await confirmDialog("TASK.md 有未保存的改动，确定放弃？", {
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
    litSource,
    pendingDecisions: pendingDecisions.length,
  });
  const seeds = step.discussionSeeds ?? [];

  function goTerminal() {
    if (!ws) return;
    // 共享交接（pipeline-start.ts）：reuseKey 切回该工作区已有标签；没有活标签时
    // resume 最近会话——「去终端看看」是回到那个对话，不是每次新开
    void buildWorkspaceTerminalRequest(ws).then((req) => {
      setPendingTerminal(req);
      setPage("terminal");
    });
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
  /** 主干节点的序号（可选区不编号——它们不在时间线上；人工事项行也不参与编号——
   *  人工序用复选框表达状态、从不显示序号，把它们算进去会让可见序号断档：
   *  ① ② [复选框行] ④，用户实测「可选项占用了一个计数但没显示」）：
   *  流程感来自「① → ② → ③」的顺序本身，光靠 ○/● 看不出先后（用户反馈） */
  const mainOrder = new Map(
    flow.nodes
      .filter((n) => n.section === "main" && n.kind !== "human")
      .map((n, i) => [n.key, i + 1] as const),
  );

  function icon(node: StepFlowNode): { text: string; cls: string } {
    const n = mainOrder.get(node.key);
    const num = n ? "①②③④⑤⑥⑦⑧⑨"[n - 1] ?? String(n) : "○";
    if (node.done) return { text: "✓", cls: "text-done" };
    if (node.key === flow.currentKey) return { text: num, cls: "text-cta" };
    return { text: num, cls: "text-l4" };
  }

  function nodeActions(node: StepFlowNode) {
    const isCurrent = node.key === flow.currentKey;
    switch (node.kind) {
      case "human": {
        const papersTarget = isPapersTarget(node.human!.target);
        // after 档事项依赖 agent 的产出才知道要做什么（付费墙清单是 agent 筛完才列出来的）。
        // 就绪口径放宽到「agent 跑完/清单已产出」（afterReady），不再死等 git 待评审——
        // 否则 agent 没提交时入口永远不出现（用户实测「没看见补充入口」）。
        // 未就绪时不给操作入口，也不写一句「等 agent」——节点排在 agent 之后，先后顺序看位置就知道。
        // 「还轮不到」由整行降透明度表达（见下方 li 的 dimmed）
        if (node.human!.timing === "after" && !afterReady(node.human!)) return null;
        // 文献类交付统一去「文献与数据」：那里三个进料口齐全（Zotero / 题录 / 扫目录），
        // 在每个事项行再复制一套入口，等于把同一件事摆三个地方
        if (papersTarget) {
          return node.done ? null : (
            <button
              type="button"
              // 按文献来源高亮对应进料口（与「确定文献来源」节点的落地口径一致），
              // 免得跳过去之后不知道点哪个（用户实测「和确定文献来源一样，没说清怎么导入」）
              onClick={() =>
                onOpenResources?.(
                  litSource === "zotero"
                    ? "zotero"
                    : litSource === "folder"
                      ? "files"
                      : undefined,
                )
              }
              title={
                hasLibrary
                  ? "新文献加进你的文献库后，到「文献与数据」重新导入即可——不必往项目里另放一份"
                  : "到「文献与数据」导入：可从 Zotero 导入、导入 RIS/BibTeX 题录，或把文件放进项目目录后重新扫描"
              }
              className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1"
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
            className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
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
              className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110"
            >
              恢复工作区
            </button>
          );
        }
        return runStatus === "pending" ? (
          // 唯一主路径（v3.89）：上面那些题都不拦着开工，所以「开始」必须比它们显眼一档。
          // 新用户直接点它就完事——AI 自己会在对话里问缺的信息
          <button
            type="button"
            onClick={onStart}
            title="直接开工也行，AI 会在对话里问你缺的信息"
            className="shrink-0 rounded-sm border border-cta-bd bg-cta px-3 py-1 text-sm text-cta-text hover:brightness-110"
          >
            开始
          </button>
        ) : runStatus === "active" ? (
          // agent 已跑完（会话尾部判定 done，大圆角标同一口径）：按钮旁给完成提示，
          // 行为不变——点进去看产出/提交情况；状态翻转仍走 git 派生（提交→待评审）
          <span className="flex shrink-0 items-center gap-1.5">
            {agentAttention === "done" && (
              <span className="text-xs text-done">✓ agent 已跑完</span>
            )}
            <button
              type="button"
              onClick={goTerminal}
              className="shrink-0 rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover"
            >
              去终端看看
            </button>
          </span>
        ) : null;
      case "review":
        if (!isCurrent || !ws) return null;
        return (
          <button
            type="button"
            onClick={goReview}
            className="shrink-0 rounded-sm border border-cta-bd bg-cta px-2 py-0.5 text-xs text-cta-text hover:brightness-110"
          >
            {reviewConflict ? "去处理冲突" : "去评审"}
          </button>
        );
      default:
        return null;
    }
  }

  /** 单个节点行（主干与可选区共用）：dense = 可选区的紧凑版（更小字号、不显示 hint） */
  const hasDiscussNode = flow.nodes.some((n) => n.kind === "discuss");

  function renderNode(node: StepFlowNode, dense = false) {
    const isCurrent = node.key === flow.currentKey;
    const ic = icon(node);
    const guidance = node.kind === "human" ? node.human?.guidance?.trim() : "";
    const guidanceShort = guidance ? guidancePreview(guidance) : "";
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
                // 「定方向」内容高，整块 bg-hover 会变成一大片色板，把主动作「开始」压下去。
                // 竖线走绝对定位压在**序号那一列**（left-[7px]，与 StepperChain 的连接线同轴），
                // 用 border-l 会画在行最左，与序号差 7px 对不上（用户实测「框线没对上」）
                "relative pl-1.5 before:absolute before:bottom-1 before:left-[7px] before:top-3 before:w-0.5 before:bg-cta before:content-['']"
              : "pl-1.5"
        } ${
          // 还轮不到（after 档且 agent 未产出/未跑完）：整行压暗，不写「等 agent」那种话
          node.kind === "human" &&
          node.human!.timing === "after" &&
          !afterReady(node.human!) &&
          !node.done
            ? "opacity-45"
            : ""
        }`}
      >
        <div className="flex items-center gap-2">
          {/* 人工事项行：复选框本身就是状态 + 控件，再画一个 ✓ 是同一件事说两遍
              （用户实测：一行两个勾）。这里只占位保持与主干节点同列对齐 */}
          <span
            className={`relative z-10 w-4 shrink-0 bg-inset text-center text-sm ${
              node.kind === "human" ? "" : ic.cls
            }`}
          >
            {node.kind === "human" ? "" : ic.text}
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
                  ? "已完成；取消勾选会保留为未完成，需重新勾选确认"
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
          {node.section === "main" &&
            node.kind === "human" &&
            node.human!.optional &&
            !node.done && (
            <span
              className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-micro text-l4"
              title="可选：不做也能跑完这一步"
            >
              可选
            </span>
          )}
          {/* 落点命中计数（v3.97）：存在性检测的进度感——见到几个文件、清单共几篇。
              显式取消后检测命中也照显示：进度感不随勾态消失（与 HumanTasksList 同文案） */}
          {node.kind === "human" && node.human!.hitCount != null && (
            <span
              className={`shrink-0 text-micro ${node.done ? "text-done" : "text-l4"}`}
            >
              已见到 {node.human!.hitCount} 个文件
              {node.human!.expectedCount != null
                ? ` / 清单共 ${node.human!.expectedCount} 篇`
                : ""}
            </span>
          )}
          {nodeActions(node)}
        </div>
        {/* 当前节点的引导与展开操作：种子 chips / 落点说明。
            例外：评审节点的验收引导不看「当前」身份（v3.97）——hint 已按 runStatus 门控
            （待开始无文案、进行中预告、待评审给步骤）；agent 跑完没提交时当前节点一直停在
            agent 上，若死守 isCurrent，验收引导永远显示不出来（用户实测） */}
        {!dense && (isCurrent || node.kind === "review") && node.hint && (
          <p className="mt-0.5 pl-9 text-micro text-l4">{node.hint}</p>
        )}
        {node.kind === "input" && onSetLitSource && (
          // pl-9 与其余内容区（hint/agentContent）对齐到步骤名左缘，不顶到序号
          <div className="ml-9 rounded-md bg-strip px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {LIT_SOURCES.map((o) => {
                const on = (litSource || "search") === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    disabled={litBusy}
                    onClick={() => void onSetLitSource(o.id)}
                    title={o.hint}
                    className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                      on
                        ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
                        : "bg-inset text-l3 hover:bg-hover hover:text-l1"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
              {/* 动作链接并进同一行（v3.89）：原先独占一行，还配一句与选项 title 重复的小字。
                  动作跟着所选来源走；落点统一是「文献与数据」（导入只此一处），
                  链接常驻——选了让 agent 检索也可能想补几篇 */}
              {(() => {
                const cur =
                  LIT_SOURCES.find((o) => o.id === (litSource || "search")) ??
                  LIT_SOURCES[0];
                return onOpenResources && cur.action ? (
                  <button
                    type="button"
                    onClick={() => onOpenResources(cur.focus)}
                    title={cur.hint}
                    className="ml-auto shrink-0 rounded-sm px-1 py-0.5 text-xs text-l2 underline decoration-dotted underline-offset-2 hover:bg-hover hover:text-l1"
                  >
                    {cur.action}
                  </button>
                ) : null;
              })()}
            </div>
          </div>
        )}
        {/* 想法区与「跟 AI 商量」：discuss 节点存在时挂它，否则挂 agent 节点（v3.89）——
            内容一字未动，只是换了落点，避免节点被隐藏时这些入口一起消失 */}
        {(node.kind === "discuss" ||
          (node.kind === "agent" && !hasDiscussNode)) && (
          <div className="mt-1 space-y-1.5 pl-9">
            {/* ── 输入准备（v3.86；v3.89 升格为独立 input 节点，排在 AI 干活之前）──
                · 决策项：答案写进任务书草稿，纯记录，给 agent 看的合同内容
                · 文献来源：答案写进项目配置 lit_source，要动手（导入），还会改变这一步的性质
                  （系统检索 → 盘点已有 + 查漏补缺）
                所以它是「这一步的输入从哪来」，不是「这一步怎么做」，单独成块 + 自带动作按钮。
                答完且没有待办动作时收成一行，不长期占地方。 */}
            {/* 决策项 = 方式一（点卡片直接定）：可枚举的拍板点一行一题，点选即答——不开终端、不建卡、不切页。
                与「跟 AI 商量一下」（方式二 · 聊着定）是确定 TASK.md 的两条并列路径，终点相同（v3.90 用户拍板挑明） */}
            {decisions.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  {/* 默认折叠（v3.89）：这些题**不拦着开工**（不答也能点「开始」），
                      但摊开成一列待答清单看着像必办任务——每步 0~3 件还没规律，
                      用户无从预期。降为「想省事就点两下」的快捷方式 */}
                  <button
                    type="button"
                    onClick={() => setDecisionsOpen((v) => !v)}
                    aria-expanded={decisionsOpen}
                    className="flex min-w-0 items-center gap-1 text-xs text-l3 hover:text-l1"
                  >
                    <span className="w-3 text-l4">
                      {decisionsOpen ? "▾" : "▸"}
                    </span>
                    {pendingDecisions.length > 0
                      ? `直接选择（${pendingDecisions.length} 项待定）`
                      : "直接选择（已定）"}
                  </button>
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
                {decisionsOpen &&
                  decisions.map((d) => {
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
                            className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-50 ${
                              on
                                ? "border border-cta-bd bg-cta-pill text-cta-pill-text"
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
                          className="rounded-full border border-cta-bd bg-cta-pill px-2 py-0.5 text-xs text-cta-pill-text hover:brightness-110"
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
                      className="min-w-0 flex-1 rounded-sm border border-field bg-canvas px-1.5 py-0.5 text-xs text-l1 outline-none focus:border-cta-bd"
                    />
                    <button
                      type="submit"
                      disabled={decisionBusy || !writeOwn.text.trim()}
                      className="shrink-0 rounded-sm border border-cta-bd bg-cta px-1.5 py-0.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
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
            {/* 方式一/方式二同形（v3.90 走查，用户拍板）：两条路都是「可折叠的一行」——
                ▸ 折叠只露一行标签，▾ 展开才露动作（方式一展开是卡片、方式二展开是聊天按钮）。
                「预览/编辑 TASK.md」是看结果不是第三条路——固定在行尾（与方式一行的
                「全部用推荐值」同位），不参战 */}
            {decisions.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setChatOpen((v) => !v)}
                    aria-expanded={chatOpen}
                    className="flex min-w-0 items-center gap-1 text-xs text-l3 hover:text-l1"
                  >
                    <span className="w-3 text-l4">{chatOpen ? "▾" : "▸"}</span>
                    和 AI 商量（可选）
                  </button>
                  <span className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!draft}
                      onClick={() => void openDraftInline()}
                      title="查看/编辑这一步的 TASK.md（没改过时是模板默认拼装，可直接改）"
                      className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      预览/编辑 TASK.md
                    </button>
                  </span>
                </div>
                {chatOpen && (
                  <div className="flex flex-wrap items-center gap-2 pl-4">
                    <button
                      type="button"
                      disabled={!draft || chatBusy}
                      onClick={() => void chatDraft()}
                      className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                    >
                      {chatBusy ? "准备 TASK.md…" : "跟 AI 商量一下"}
                    </button>
                    <span className="text-xs text-l4">结论会写入 TASK.md</span>
                  </div>
                )}
              </div>
            ) : (
              /* 无决策项的步骤：方式一不存在，不标「方式二」（会让人找方式一）——维持单按钮形态 */
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!draft || chatBusy}
                  onClick={() => void chatDraft()}
                  title="开终端跟 AI 一起过一遍任务书：它读稿提问、你拍板、它直接改稿——改的就是最终落盘的 TASK.md"
                  className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                >
                  {chatBusy ? "准备 TASK.md…" : "跟 AI 商量一下"}
                </button>
                {!draftHasBody && (
                  <span className="text-xs text-l4">
                    可选 · 结论写入 TASK.md
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!draft}
                    onClick={() => void openDraftInline()}
                    title="查看/编辑这一步的 TASK.md（没改过时是模板默认拼装，可直接改）"
                    className="rounded-sm border border-field px-1.5 py-0.5 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50"
                  >
                    预览/编辑 TASK.md
                  </button>
                </span>
              </div>
            )}
            {chatError && (
              <p className="text-micro text-err-text">{chatError}</p>
            )}
            {/* 预置话题 chips：只列还没开聊过的——开过的已经以话题行躺在下面的清单里，
                两处都显示会让人以为是两个东西。点击 = 只读开聊（同话题清单口径），
                「让 agent 直接改草稿」是上面那颗「跟 Agent 聊任务书」的活，两者不重叠 */}
            {/* 预置话题：不再是独立一区，而是「跟 AI 商量」的现成话头。
                前缀「聊聊：」让它一眼看出是同一件事的快捷入口，不是第三个功能 */}
            {(openSeeds ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-l4">或直接聊：</span>
                {(openSeeds ?? []).map((seed) => (
                  <button
                    key={seed}
                    type="button"
                    onClick={() => onSeed(seed)}
                    title="就这个问题开聊，结论可以沉淀进任务书"
                    className="rounded-full bg-strip px-2 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
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
        {node.kind === "agent" && agentContent && (
          <div className="mt-0.5 pl-9">{agentContent}</div>
        )}
        {/* 说明只在当前节点显示：一屏同时摊开五段说明是这一页最大的噪音源。
            非当前节点的说明挂在行的 title 上（悬停可见），信息不丢。
            例外（v3.97）：可选的 after 档事项被设计成不抢「当前节点」，若死守 isCurrent，
            「下载付费墙文献全文」的导入说明就只剩悬停可见（用户实测「没说清怎么导入」）——
            就绪（afterReady）且未完成时就地展示摘要；长 guidance 的完整做法收进「怎么做」详情。 */}
        {!dense &&
          node.kind === "human" &&
          guidance &&
          (isCurrent ||
            (!node.done &&
              node.human!.timing === "after" &&
              afterReady(node.human!))) && (
            <div className="mt-0.5 pl-9 text-micro leading-5 text-l4">
              <p className="whitespace-pre-wrap">{guidanceShort}</p>
              {guidanceShort !== guidance && (
                <details className="mt-0.5">
                  <summary className="cursor-pointer select-none text-micro text-l4 hover:text-l2">
                    怎么做
                  </summary>
                  <p className="mt-0.5 whitespace-pre-wrap text-l3">
                    {guidance}
                  </p>
                </details>
              )}
            </div>
          )}
      </li>
    );
  }

  return (
    <div
      ref={containerRef}
      className={bare ? "" : "rounded-md bg-inset px-2.5 py-2"}
    >
      {/* 主干节点用左侧竖线串起来（连接线落在序号列正下方，1.5px 极淡）：
          没有连线时三个节点像三条独立的行，读不出「这是一条流程」 */}
      <ol className="relative space-y-1 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-hairline before:content-['']">
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
      {/* TASK.md 就地编辑弹层：不跳终端页。背景点击在有未保存改动时会先确认 */}
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
                TASK.md：{step.name}
              </h2>
              <button
                type="button"
                onClick={() => setDraftPreview((v) => !v)}
                title={
                  draftPreview ? "回到编辑" : "看渲染后的排版（长文档好读）"
                }
                className="ml-auto shrink-0 self-center rounded-sm border border-field px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
              >
                {draftPreview ? "编辑" : "预览"}
              </button>
            </div>
            {draftPreview ? (
              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
                <div
                  ref={draftHtmlRef}
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
                className="min-h-0 flex-1 resize-none rounded-md border border-field bg-canvas p-3 font-mono text-xs leading-5 text-l2 outline-none focus:border-cta-bd"
              />
            )}
            <p className="mt-2 shrink-0 text-micro text-l4">
              {draftEdit.fromTemplate
                ? "当前是模板默认拼装，还没改过；保存后开工就以这份为准。"
                : "开工时这份内容将原样落成工作区的 TASK.md。"}
            </p>
            <div className="mt-3 flex shrink-0 items-center gap-2">
              {!draftEdit.fromTemplate && (
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
              )}
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
                      : "保存为开工用的 TASK.md 内容"
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
