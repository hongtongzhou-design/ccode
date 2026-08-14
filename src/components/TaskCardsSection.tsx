import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { hoverRevealClass, LoadingRows, Toggle } from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import StepFlow from "./StepFlow";
import FuseDraftModal from "./FuseDraftModal";
import { useAppStore } from "../store";
import {
  bucketCardsByStep,
  discussionCardsForStep,
  extractOpenQuestions,
  ideaCardsForStep,
} from "../task-cards";
import { buildTaskMdPreview } from "../pipeline-start";
import type {
  ProjectConfigDto,
  ProjectStepDto,
  SkillDto,
  TaskCardDto,
  WorkspaceDto,
} from "../types";

const actionBtn =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50";
const fieldSm =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

/** 待拍板问题：卡片所属步骤的任务书草稿「## 待拍板」小节的只读视图（extractOpenQuestions 纯逻辑）。
 *  挂载读一次草稿（read_task_draft），无小节或无条目不渲染；无步骤语境（未挂步骤卡）不挂载本块。
 *  点条目 = 带着这个问题去聊（onSeed 草稿口径：结论直接写进草稿） */
function OpenQuestions({
  projectPath,
  stepName,
  onPick,
}: {
  projectPath: string;
  stepName: string;
  onPick: (question: string) => void;
}) {
  const [questions, setQuestions] = useState<string[] | null>(null);
  useEffect(() => {
    let stale = false;
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: projectPath,
      stepName,
    })
      .then((d) => {
        if (!stale) setQuestions(extractOpenQuestions(d.text ?? ""));
      })
      .catch(() => {
        if (!stale) setQuestions([]);
      });
    return () => {
      stale = true;
    };
  }, [projectPath, stepName]);
  if (!questions || questions.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-micro text-l4">
        待拍板（{questions.length}）——来自任务书草稿，点了去聊
      </div>
      <ul className="space-y-0.5">
        {questions.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              title="开终端讨论这个问题（结论直接写进任务书草稿）"
              className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              <span className="shrink-0 text-micro text-warn-text">?</span>
              <span className="min-w-0 truncate">{q}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 认领登记的 agent：与终端启动栏的种子口径一致（ccode.lastLaunch → claude-code 兜底）。
 *  用户在启动栏临时换了 agent 时登记会落空——静默降级，事后仍可在对话页手动归卡 */
function launchBarAgent(): string {
  try {
    const saved = JSON.parse(
      localStorage.getItem("ccode.lastLaunch") ?? "{}",
    ) as Partial<{ agentId: string }>;
    return saved.agentId ?? "claude-code";
  } catch {
    return "claude-code";
  }
}

/**
 * 任务卡区（项目详情，流水线步进器下方）：卡片 = 对话的归档文件夹（任务书沉淀统一走草稿）。
 * 按步骤分桶（失效步骤的卡并入「未挂步骤」桶）；行主动作 = 聊想法（未绑工作区）/ 开工
 * （挂步骤的卡，走一键开步链路）/ 继续（已绑工作区，开终端预填「阅读 TASK.md 并继续任务」）。
 * 展开手风琴按卡片 id 记忆在本组件内——ProjectGroup 以项目 key 挂载，切项目自然清空。
 */
export default function TaskCardsSection({
  projectPath,
  steps,
  cfg,
  workspaces,
  refreshToken,
  mainDirty,
  focusStep,
  focusStatusText,
  focusRunStatus,
  focusHumanPending,
  reviewConflict,
  onRestoreWorkspace,
  onClearFocus,
  onHumanChanged,
  onStartStep,
  focusDraft,
  onDraftChanged,
}: {
  projectPath: string;
  steps: ProjectStepDto[];
  /** 项目档案卡（步骤级「预览 TASK.md」拼装用，renderTaskMd 同一出处） */
  cfg: ProjectConfigDto;
  workspaces: WorkspaceDto[];
  /** 页面刷新令牌：评审沉淀等页外写入后随刷新重读 */
  refreshToken: number;
  /** 主仓未提交改动数（null = 非 git 仓库/未知）：非零时标题行右侧显示协同提醒 */
  mainDirty: number | null;
  /** 步骤聚焦（v3.70）：非 null 时只显示该步骤的种子/卡片/人工事项；null = 全部 */
  focusStep?: string | null;
  /** 聚焦步骤的状态白话短语（聚焦头部用；由父级 describeStep 口径派生） */
  focusStatusText?: string | null;
  /** 聚焦步骤的执行状态（v3.71 流程线用；由父级从工作区派生——健康/漂移数据在本组件外） */
  focusRunStatus?: "pending" | "active" | "review" | "done";
  /** 聚焦步骤轮到人做的待办事项标题（父级「等你做」口径）：流程线 human 节点橙点 */
  focusHumanPending?: string[];
  /** 聚焦步骤处于合并冲突阻塞：流程线评审节点入口改为「去处理冲突」 */
  reviewConflict?: boolean;
  /** 聚焦步骤的工作区已归档：流程线 agent 节点主入口改为「恢复工作区」 */
  onRestoreWorkspace?: () => void;
  /** 「总览全部步骤」回调（清除聚焦） */
  onClearFocus?: () => void;
  /** 人工事项勾选/交付后通知父级（流程线橙点与 ⋯ 菜单计数重取） */
  onHumanChanged?: () => void;
  /** 卡片「开工」：打开开工确认弹层（originCardId = 出处卡）；返回 Promise 供行内 busy 态跟随 */
  onStartStep: (index: number, originCardId?: string) => Promise<void> | void;
  /** 聚焦步骤的任务书草稿（v3.72；ProjectGroup 单一加载点下发）：discuss 节点状态与「聊任务书」指令用 */
  focusDraft?: { relPath: string; text: string | null } | null;
  /** 「◈ 融合进任务书」落盘后回调：ProjectGroup 即刻重读 focusDraft（不等页面刷新） */
  onDraftChanged?: () => void;
}) {
  const cards = useAppStore((s) => s.taskCards[projectPath]);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const createCard = useAppStore((s) => s.createCard);
  const renameCard = useAppStore((s) => s.renameCard);
  const deleteCard = useAppStore((s) => s.deleteCard);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // 想法期只读保护开关（settings.json，默认开）
  const discussGuard = useAppStore((s) => s.settings?.discussReadonly !== false);
  const [error, setError] = useState<string | null>(null);
  // 展开手风琴：按卡片 id 记忆（切项目随组件重挂载清空，与产物清单口径一致）
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 新建内联表单：键 = 步骤名，空串 = 未挂步骤桶
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    card: TaskCardDto;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 想法区（聚焦态专属）：新建内联表单 + 融合弹层目标卡
  const [ideaFormOpen, setIdeaFormOpen] = useState(false);
  const [ideaName, setIdeaName] = useState("");
  const [fusing, setFusing] = useState<TaskCardDto | null>(null);
  // 步骤级 TASK.md 预览（只读弹层）：步骤名 + 拼装结果 + 技能库元数据（推荐技能区的描述来源）
  const [taskMdPreview, setTaskMdPreview] = useState<{
    stepName: string;
    text: string | null;
  } | null>(null);
  const [skillLib, setSkillLib] = useState<SkillDto[] | null>(null);

  useEffect(() => {
    let stale = false;
    loadTaskCards(projectPath).catch((e) => {
      if (!stale) setError(String(e));
    });
    return () => {
      stale = true;
    };
  }, [projectPath, refreshToken, loadTaskCards]);

  const buckets = (() => {
    const all = bucketCardsByStep(
      cards ?? [],
      steps.map((s) => s.name),
    );
    // 步骤聚焦：只保留聚焦步骤的桶（「未挂步骤」桶在聚焦时隐藏——它不属于任何步骤）；
    // 桶内只留 draft 讨论卡——idea 想法卡已上移到流程线上方的想法区，不重复出现
    if (!focusStep) return all;
    return all
      .filter((b) => b.step === focusStep)
      .map((b) => ({ ...b, cards: discussionCardsForStep(b.cards, focusStep) }));
  })();
  /** 聚焦步骤的想法卡（kind=idea，想法区用） */
  const ideaCards = focusStep ? ideaCardsForStep(cards ?? [], focusStep) : [];
  /** 聚焦步骤的声明（人工事项清单/种子用）；聚焦名失效（步骤被删/改名）时 null → 聚焦桶为空 */
  const focusStepDto = focusStep
    ? (steps.find((s) => s.name === focusStep) ?? null)
    : null;

  async function submitCreate(step: string | null, e: React.FormEvent) {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    setError(null);
    try {
      await createCard(projectPath, name, step);
      setCreatingIn(null);
      setDraftName("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 想法区「＋ 新建想法」：kind=idea、挂当前聚焦步骤；不开聊，只建卡 */
  async function submitCreateIdea(e: React.FormEvent) {
    e.preventDefault();
    if (!focusStep) return;
    const name = ideaName.trim();
    if (!name) return;
    setError(null);
    try {
      await createCard(projectPath, name, focusStep, "idea");
      setIdeaFormOpen(false);
      setIdeaName("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    setError(null);
    try {
      await renameCard(projectPath, renaming.id, renaming.name.trim());
      setRenaming(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function onDelete(card: TaskCardDto) {
    if (
      !(await confirmDialog(
        `删除卡片「${card.name}」？卡片内的对话会移出卡片（对话本身不删除），任务书草稿不受影响。继续？`,
        { danger: true },
      ))
    )
      return;
    setError(null);
    try {
      await deleteCard(projectPath, card.id);
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 从卡片发起聊天前登记认领（claim_next_session_for_card：该项目的下一个新会话自动归卡）。
   *  cwd 一律用项目根——工作区内会话的 project_path 已被后端改写为真实仓库，认领照样命中。
   *  登记失败静默降级：不阻断开终端，会话事后可在对话页手动归卡 */
  function claimForCard(card: TaskCardDto) {
    invoke("claim_next_session_for_card", {
      agent: launchBarAgent(),
      cwd: projectPath,
      taskId: card.id,
    }).catch(() => {});
  }

  /** 聊想法（idea 卡专用——想法区行内主按钮与 ⋯ 菜单；draft 卡的讨论并入 onSeed 草稿口径）：项目根开终端（不建工作区——想法期不动手）。
   *  想法期只读保护（卡片区标题行开关，默认开；allowEdit = ⋯ 菜单的单次豁免）：
   *  开 = 预填指令带不动文件约束 + readonly 标记（后端对支持的 CLI 注入只读/计划模式参数——硬保护）；
   *  关/豁免 = 纯聊天，不动参数。
   *  kimi/opencode 无启动注入参数：启动栏保留指令文本由用户手动发送（promptDropped 既有处理） */
  function onDiscuss(card: TaskCardDto, allowEdit = false, topic?: string) {
    claimForCard(card);
    const guard = useAppStore.getState().settings?.discussReadonly !== false;
    const protect = guard && !allowEdit;
    const opening = topic
      ? `我想跟你探讨「${card.name}」里的待拍板问题：${topic}`
      : `我想跟你探讨：${card.name}`;
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: card.name,
      readonly: protect || undefined,
      initialPrompt: protect
        ? `${opening}。注意：现在只讨论方案，不要修改/新建/删除任何文件；我认为需要动手时会明确告诉你。`
        : opening,
    });
    setPage("terminal");
  }

  /** 开工：挂步骤的卡打开开工确认弹层（TASK.md 预览编辑，草稿优先），确认后才建工作区 */
  function onStart(card: TaskCardDto) {
    const index = steps.findIndex((s) => s.name === card.step);
    if (index < 0 || busyId) return;
    claimForCard(card);
    setBusyId(card.id);
    void Promise.resolve(onStartStep(index, card.id))
      .catch(() => {})
      .finally(() => setBusyId(null));
  }

  /** 讨论种子/挂步骤卡「聊想法」点击即聊（v3.72 任务书口径）：以种子问题为名建卡归档
      （已有同名卡则直接续聊——挂步骤卡的「聊想法」也走这里，topic 可另带讨论问题），
      非只读启动——讨论出的结论 agent 直接写进任务书草稿（指令约束只许动这一个文件）。
      开聊同时带开草稿预览（previewPath/previewRoot 交接给终端页右栏） */
  async function onSeed(stepName: string, seed: string, topic?: string) {
    setError(null);
    try {
      // 草稿路径单一出处在后端（不存在也返回 relPath）
      const d = await invoke<{ relPath: string }>("read_task_draft", {
        projectRoot: projectPath,
        stepName,
      }).catch(() => null);
      const existing = (cards ?? []).find((c) => c.name === seed);
      const card = existing ?? (await createCard(projectPath, seed, stepName));
      claimForCard(card);
      setPendingTerminal({
        cwd: projectPath,
        extraEnv: {},
        title: card.name,
        initialPrompt:
          `我们在完善「${stepName}」这一步的任务书草稿（${d?.relPath ?? ".ccode/drafts/ 下对应步骤的文件"}）。` +
          `先聊这个问题：${topic ?? seed}。讨论出的结论直接整理进这个草稿文件——只允许新建/修改这一个文件，其他文件一律不要动。` +
          `讨论中没定下来的问题，记到草稿的「## 待拍板」小节。`,
        // 开聊时自动带开草稿预览（草稿不存在时预览随后刷新即可见）
        ...(d?.relPath
          ? {
              previewPath: `${projectPath.replace(/[\\/]+$/, "")}/${d.relPath}`,
              previewRoot: projectPath,
            }
          : {}),
      });
      setPage("terminal");
    } catch (reason) {
      setError(String(reason));
    }
  }

  /** 主仓提醒行点击：开主仓 shell 标签并直接落到「改动」页签（pendingTerminal.rightTab 一次性交接） */
  function openMainChanges() {
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: "主仓改动",
      shellOnly: true,
      rightTab: "git",
    });
    setPage("terminal");
  }

  /** 继续（已绑定工作区的卡）：开终端新会话，cwd = 工作树，预填「阅读 TASK.md 并继续任务」。
   *  kimi/opencode 无启动注入参数：启动栏保留指令文本由用户手动发送（pty_spawn promptDropped 既有处理） */
  function onContinue(card: TaskCardDto) {
    const ws = card.workspace
      ? workspaces.find(
          (w) => w.name === card.workspace && w.status === "active",
        )
      : undefined;
    if (!ws) return; // 绑定工作区不存在/已归档：renderCard 不渲染「继续」，此处兜底
    claimForCard(card);
    setPendingTerminal({
      cwd: ws.worktreePath,
      extraEnv: {},
      title: card.name,
      initialPrompt: "阅读 TASK.md 并继续任务",
    });
    setPage("terminal");
  }

  /** 步骤级「预览 TASK.md」：模板拼装当前 TASK.md，只读展示；
   *  无卡无工作区也可预览（模板 + 提货单）。与开工落盘同一 renderTaskMd 出处 */
  function onPreviewTaskMd(stepName: string) {
    const step = steps.find((s) => s.name === stepName);
    if (!step) return;
    setTaskMdPreview({ stepName, text: null });
    // 技能库描述（推荐技能区用）：与预览并行加载，失败则只列技能名
    if (!skillLib) {
      invoke<SkillDto[]>("list_skills")
        .then(setSkillLib)
        .catch(() => {});
    }
    buildTaskMdPreview(projectPath, step, cfg)
      .then((text) =>
        setTaskMdPreview((cur) => (cur?.stepName === stepName ? { stepName, text } : cur)),
      )
      .catch((e) =>
        setTaskMdPreview((cur) =>
          cur?.stepName === stepName
            ? { stepName, text: `预览生成失败：${String(e)}` }
            : cur,
        ),
      );
  }

  function toggleOpen(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 想法卡行（想法区）：主按钮 = 只读纯聊「聊想法」；「◈ 融合进任务书」只在开工前渲染
   *  （步骤已有活跃工作区 = runStatus 非 pending 时藏融合，卡仍可续聊） */
  function renderIdeaCard(card: TaskCardDto) {
    const canFuse = (focusRunStatus ?? "pending") === "pending";
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover">
          <span className="min-w-0 flex-1 truncate text-xs text-l1">
            {card.name}
          </span>
          <button
            type="button"
            onClick={() => onDiscuss(card)}
            title="在项目根开终端聊聊这个想法（不建工作区，只读纯聊），新会话自动归入本卡"
            className={`${actionBtn} shrink-0`}
          >
            聊想法
          </button>
          {canFuse && (
            <button
              type="button"
              onClick={() => setFusing(card)}
              title="AI 把这张卡的讨论结论织进当前步骤的任务书草稿；先出稿给你改，确认后才写入"
              className={`${actionBtn} shrink-0`}
            >
              ◈ 融合进任务书
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.right, y: rect.bottom + 4, card });
            }}
            title="卡片操作"
            aria-label={`卡片操作：${card.name}`}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
          >
            ⋯
          </button>
        </div>
        {renaming?.id === card.id && (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 py-1"
          >
            <input
              className={`${fieldSm} min-w-0 flex-1`}
              value={renaming.name}
              onChange={(e) =>
                setRenaming({ id: card.id, name: e.target.value })
              }
              autoFocus
              required
            />
            <button type="submit" className={actionBtn}>
              确定
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setRenaming(null)}
            >
              取消
            </button>
          </form>
        )}
      </li>
    );
  }

  function renderCard(card: TaskCardDto) {
    // 「开工」是任务书讨论卡（draft）的路径；想法卡（idea）的路径是「◈ 融合进任务书」，不给开工入口
    const canStart =
      card.kind === "draft" &&
      card.step !== null &&
      steps.some((s) => s.name === card.step);
    // 已绑定工作区（活跃）= 已开工：主按钮「继续」；未绑定的挂步骤卡 = 想法期：「聊想法」+「开工」；
    // 未挂步骤卡只有「聊想法」（onDiscuss 只读纯聊）
    const boundWs = card.workspace
      ? workspaces.find(
          (w) => w.name === card.workspace && w.status === "active",
        )
      : undefined;
    const expanded = open.has(card.id);
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover">
          <button
            type="button"
            onClick={() => toggleOpen(card.id)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={expanded ? "收起" : "展开（待拍板）"}
          >
            <span className="w-3 shrink-0 text-micro text-l4">
              {expanded ? "▾" : "▸"}
            </span>
            <span className="min-w-0 truncate text-xs text-l1">
              {card.name}
            </span>
          </button>
          {boundWs ? (
            <button
              type="button"
              onClick={() => onContinue(card)}
              title="开终端新会话，预填「阅读 TASK.md 并继续任务」；会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              继续
            </button>
          ) : canStart ? (
            <button
              type="button"
              onClick={() => void onSeed(card.step!, card.name)}
              title="继续这张卡的讨论，结论直接写进任务书草稿；新会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              接着聊
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onDiscuss(card)}
              title="在项目根开终端聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              聊想法
            </button>
          )}
          <span className={`flex shrink-0 items-center gap-1 ${hoverRevealClass}`}>
            {!boundWs && canStart && (
              <button
                type="button"
                disabled={busyId === card.id}
                onClick={() => onStart(card)}
                title="一键开步：建工作区，任务书草稿即 TASK.md；会话自动归入本卡"
                className={actionBtn}
              >
                开工
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.right, y: rect.bottom + 4, card });
              }}
              title="卡片操作"
              aria-label={`卡片操作：${card.name}`}
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ⋯
            </button>
          </span>
        </div>
        {renaming?.id === card.id && (
          <form
            onSubmit={submitRename}
            className="flex items-center gap-1 py-1 pl-6"
          >
            <input
              className={`${fieldSm} min-w-0 flex-1`}
              value={renaming.name}
              onChange={(e) =>
                setRenaming({ id: card.id, name: e.target.value })
              }
              autoFocus
              required
            />
            <button type="submit" className={actionBtn}>
              确定
            </button>
            <button
              type="button"
              className={actionBtn}
              onClick={() => setRenaming(null)}
            >
              取消
            </button>
          </form>
        )}
        {expanded && (
          <div className="mb-1 ml-6 space-y-2 rounded-md bg-strip p-2">
            {/* 待拍板问题（卡片所属步骤的任务书草稿「## 待拍板」小节的视图，无新存储）：
                点了带问题去聊（onSeed 草稿口径）；未挂步骤卡无步骤语境，不渲染该块 */}
            {card.step !== null ? (
              <OpenQuestions
                projectPath={projectPath}
                stepName={card.step}
                onPick={(q) => void onSeed(card.step!, card.name, q)}
              />
            ) : (
              <p className="text-xs text-l4">未挂步骤的卡片没有任务书草稿</p>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-l3">
          任务卡{cards && cards.length > 0 ? `（${cards.length}）` : ""}
        </span>
        {/* 主仓改动协同提醒（与开工弹层同款口径，只提醒不阻断）：小 chip 降噪，点击跳改动面板 */}
        {mainDirty !== null && mainDirty > 0 && (
          <button
            type="button"
            onClick={openMainChanges}
            title="想法期的实验性改动留在主仓，不会带入新工作区；点击查看改动"
            className="ml-auto shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-micro text-warn-text hover:bg-hover"
          >
            主仓 {mainDirty} 个未提交改动
          </button>
        )}
        {/* 「想法期只读保护」开关已迁入聚焦态想法区标题行（它只管想法卡的只读纯聊一路） */}
      </div>
      {/* 空态即教学：还没有卡片时用一行白话讲清工作流（不做教程页）。
          聚焦时不显示（聚焦本身已是引导） */}
      {!focusStep && cards && cards.length === 0 && (
        <p className="mt-1 rounded-md bg-inset px-2.5 py-2 text-sm text-l4">
          点步骤下的种子问题开聊 → 结论直接写进任务书草稿 →
          开工时草稿就是 TASK.md。卡片只负责归档这些讨论。
        </p>
      )}
      {error && <p className="mt-1 text-xs text-err-text">{error}</p>}
      {/* 聚焦头部：步骤名 + 状态短语（父级 describeStep 口径）+ 总览切换。
          聚焦态下步骤名只出现在这里与流程线 agent 节点，桶头不再重复 */}
      {focusStep && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-sm font-semibold text-l1">{focusStep}</span>
          {focusStatusText && (
            <span className="text-xs text-l3">{focusStatusText}</span>
          )}
          {onClearFocus && (
            <button
              type="button"
              onClick={onClearFocus}
              className="ml-auto rounded-sm px-1.5 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              总览全部步骤
            </button>
          )}
        </div>
      )}
      {focusStepDto && (
        <div className="mt-1 rounded-md bg-strip px-3 py-2.5">
          {/* 想法区（v3.80，聚焦态专属，独立 strip 区域）：自由想法卡（kind=idea）——只读纯聊 + ◈ 融合进任务书；
              「想法期只读保护」开关从卡片区总标题行迁来（它只管只读纯聊一路，设置页不加行） */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-l2">
              想法区{ideaCards.length > 0 ? `（${ideaCards.length}）` : ""}
            </span>
            {ideaFormOpen ? (
              <form
                onSubmit={(e) => void submitCreateIdea(e)}
                className="flex min-w-0 flex-1 items-center gap-1"
              >
                <input
                  className={`${fieldSm} min-w-0 flex-1`}
                  value={ideaName}
                  onChange={(e) => setIdeaName(e.target.value)}
                  placeholder="想法名，如 要不要加对照实验"
                  autoFocus
                  required
                />
                <button type="submit" className={actionBtn}>
                  确定
                </button>
                <button
                  type="button"
                  className={actionBtn}
                  onClick={() => setIdeaFormOpen(false)}
                >
                  取消
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIdeaName("");
                  setIdeaFormOpen(true);
                }}
                title="开一张自由想法卡：只读纯聊，聊完可一键把结论融合进任务书草稿"
                className={`${actionBtn} text-l4 hover:text-l1`}
              >
                ＋ 新建想法
              </button>
            )}
            <span
              className="ml-auto flex shrink-0 items-center gap-1.5"
              title="开启后，想法卡的「聊想法」会以只读/计划模式启动 Agent（支持该参数的 CLI），并嘱咐它只讨论不动文件"
            >
              <span className="text-micro text-l4">想法期只读保护</span>
              <Toggle
                checked={discussGuard}
                onChange={(checked) =>
                  void updateSettings({ discussReadonly: checked }).catch((e) =>
                    setError(String(e)),
                  )
                }
                label="想法期只读保护"
              />
            </span>
          </div>
          {ideaCards.length > 0 ? (
            <ul className="mt-1 divide-y divide-hairline">
              {ideaCards.map(renderIdeaCard)}
            </ul>
          ) : (
            <p className="mt-1 text-micro text-l4">
              还没有想法。「＋ 新建想法」开一张卡：只读纯聊，聊完可一键把结论融合进任务书草稿。
            </p>
          )}
        </div>
      )}
      {focusStepDto && (
        <div className="mt-1">
          {/* 步骤内协同流程线（v3.71）：人/agent 动作按先后排成节点链，当前节点就地操作 */}
          <StepFlow
            projectPath={projectPath}
            step={focusStepDto}
            runStatus={focusRunStatus ?? "pending"}
            hasDraft={!!focusDraft?.text?.trim()}
            draft={
              focusDraft
                ? {
                    relPath: focusDraft.relPath,
                    exists: !!focusDraft.text?.trim(),
                  }
                : undefined
            }
            agentContent={
              <button
                type="button"
                onClick={() => onPreviewTaskMd(focusStepDto.name)}
                title="预览该步骤当前 TASK.md 拼装结果（模板简报 + 提货单）"
                className={`${actionBtn} text-l4 hover:text-l1`}
              >
                预览 TASK.md
              </button>
            }
            ws={workspaces.find(
              (w) =>
                w.name === focusStepDto.workspaceName && w.status === "active",
            )}
            humanPending={focusHumanPending}
            reviewConflict={reviewConflict}
            onRestore={onRestoreWorkspace}
            onSeed={(seed) => void onSeed(focusStepDto.name, seed)}
            onStart={() =>
              void onStartStep(
                steps.findIndex((s) => s.name === focusStepDto.name),
              )
            }
            onChanged={onHumanChanged}
          />
        </div>
      )}
      <div className="mt-1 space-y-1">
        {buckets.map((bucket) => {
          const key = bucket.step ?? "";
          // 「未挂步骤」桶空时整桶不渲染（它出现时必带卡）
          if (bucket.step === null && bucket.cards.length === 0) return null;
          const bucketSeeds =
            bucket.step !== null
              ? (steps.find((s) => s.name === bucket.step)?.discussionSeeds ??
                [])
              : [];
          // 总览态桶强制展开，没卡也没种子的桶给一行占位——「总览全部步骤」要有明确的视觉变化
          return (
            <div key={key || "__unattached__"} className="group">
              {/* 聚焦态不渲染桶头：步骤名已在聚焦头部与流程线，讨论入口（种子＋自定义话题）
                  已并入流程线「任务书」节点，此处不再重复。总览态才需要桶头（步骤名＋＋添加想法） */}
              {!focusStep && (
              <div className="flex h-7 items-center gap-2">
                <span className="text-sm text-l2">
                  {bucket.step ?? "未挂步骤"}
                </span>
                {creatingIn === key ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = draftName.trim();
                      if (!name) return;
                      // 挂步骤的话题 = 服务于该步骤 TASK.md：与种子/自定义话题同口径，
                      // 建卡归档 + 直接开聊写草稿；未挂步骤的卡无步骤语境，只建卡归档
                      if (bucket.step) {
                        setCreatingIn(null);
                        setDraftName("");
                        void onSeed(bucket.step, name);
                      } else {
                        void submitCreate(bucket.step, e);
                      }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1"
                  >
                    <input
                      className={`${fieldSm} min-w-0 flex-1`}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder={
                        bucket.step
                          ? "话题名，回车开聊（结论直接进任务书草稿）"
                          : "卡片名，如 方法对比整理"
                      }
                      autoFocus
                      required
                    />
                    <button type="submit" className={actionBtn}>
                      确定
                    </button>
                    <button
                      type="button"
                      className={actionBtn}
                      onClick={() => setCreatingIn(null)}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  /* 桶头按钮降噪用悬停才现 */
                  <span className={`flex items-center gap-1 ${hoverRevealClass}`}>
                    {/* 步骤级 TASK.md 预览全页唯一入口 = 流程线 agent 节点，桶头不再重复 */}
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName("");
                        setCreatingIn(key);
                      }}
                      title={
                        bucket.step
                          ? "起一个种子没覆盖到的话题开聊：自动建卡归档，结论直接写进本步骤任务书草稿（开工时就是 TASK.md）"
                          : "手动开一张讨论卡：起个名建卡，之后点卡片「聊想法」去跟 Agent 聊，对话与简报自动归到这张卡"
                      }
                      className={`${actionBtn} text-l4 hover:text-l1`}
                    >
                      ＋ 添加想法
                    </button>
                  </span>
                )}
              </div>
              )}
              {/* 讨论种子（模板预置的「开工前建议想清楚的问题」）：点击即聊——
                  自动以问题建卡（已有同名卡直接续聊），卡片不再靠用户凭空想话题。
                  聚焦时种子已进流程线的 discuss 节点，桶内不重复渲染 */}
              {!focusStep && bucket.step !== null && bucketSeeds.length > 0 && (
                <div className="mb-1 flex flex-wrap items-center gap-1">
                  <span className="text-micro text-l4">开工前聊聊：</span>
                  {bucketSeeds.map((seed) => {
                    const exists = (cards ?? []).some((c) => c.name === seed);
                    return (
                      <button
                        key={seed}
                        type="button"
                        onClick={() => void onSeed(bucket.step!, seed)}
                        title={
                          exists
                            ? "已有同名卡片，点击继续聊"
                            : "点击就这个问题开聊（自动建卡，结论直接写进任务书草稿）"
                        }
                        className="rounded-full bg-inset px-2 py-0.5 text-micro text-l3 hover:bg-hover hover:text-l1"
                      >
                        {seed}
                      </button>
                    );
                  })}
                </div>
              )}
              {!focusStep &&
                bucket.step !== null &&
                bucket.cards.length === 0 &&
                bucketSeeds.length === 0 && (
                  <p className="mb-1 text-xs text-l4">该步骤还没开始</p>
                )}
              {bucket.cards.length > 0 && (
                <ul className="divide-y divide-hairline">
                  {bucket.cards.map(renderCard)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {/* 步骤级 TASK.md 只读预览弹层（拼装与开工落盘同一出处） */}
      {taskMdPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 ccode-fade"
          onClick={() => setTaskMdPreview(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-md border border-field ccode-float-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-3 shrink-0 text-base font-semibold text-l1">
              TASK.md 预览：{taskMdPreview.stepName}
            </h2>
            {/* 推荐技能区（只读；开工确认弹层里可增删） */}
            <StepSkillsChips
              skills={
                steps.find((s) => s.name === taskMdPreview.stepName)?.skills ??
                []
              }
              skillMeta={
                skillLib
                  ? Object.fromEntries(
                      skillLib.map((s) => [s.name, s.description]),
                    )
                  : undefined
              }
              skillLib={skillLib}
            />
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
              {taskMdPreview.text === null ? (
                <div className="p-3">
                  <LoadingRows compact />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words p-3 font-mono text-micro leading-5 text-l2">
                  {taskMdPreview.text}
                </pre>
              )}
            </div>
            <div className="mt-4 flex shrink-0 justify-end">
              <button
                type="button"
                onClick={() => setTaskMdPreview(null)}
                className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {fusing && focusStepDto && (
        <FuseDraftModal
          projectPath={projectPath}
          card={fusing}
          stepName={focusStepDto.name}
          onClose={() => setFusing(null)}
          onWritten={() => {
            setFusing(null);
            onDraftChanged?.();
          }}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            // 只读纯聊（onDiscuss）给想法卡（kind=idea，含未挂步骤卡——旧卡按 step 推断后两者等价）：
            // draft 讨论卡的讨论已并入 onSeed 草稿口径（行内主按钮「接着聊」）
            ...(menu.card.kind === "idea"
              ? [
                  {
                    label: "聊想法",
                    title:
                      "在项目根开终端聊聊这张卡（不建工作区，只读纯聊），新会话自动归入本卡",
                    onSelect: () => onDiscuss(menu.card),
                  },
                ]
              : []),
            // 单次豁免：不动「想法期只读保护」开关，本次允许 Agent 改文件（开关关时无意义不渲染）
            ...(discussGuard && menu.card.kind === "idea"
              ? [
                  {
                    label: "聊想法（允许改文件）",
                    title:
                      "只此一次以普通模式启动（不注入只读参数、不带不动文件约束）；开关保持开",
                    onSelect: () => onDiscuss(menu.card, true),
                  },
                ]
              : []),
            {
              label: "重命名",
              onSelect: () =>
                setRenaming({ id: menu.card.id, name: menu.card.name }),
            },
            {
              label: "删除卡片",
              danger: true,
              onSelect: () => void onDelete(menu.card),
            },
          ]}
        />
      )}
    </div>
  );
}
