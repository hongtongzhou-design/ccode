import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { hoverRevealClass, LoadingRows, Toggle } from "./PageFrame";
import StepSkillsChips from "./StepSkillsChips";
import StepFlow from "./StepFlow";
import { useAppStore } from "../store";
import { absTime, relTime } from "../rel-time";
import {
  briefSourcesForStep,
  briefTimeFromPath,
  bucketCardsByStep,
  checkedBriefRefs,
  defaultCheckedSources,
  extractOpenQuestions,
  latestBrief,
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

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 待拍板问题：最新定稿简报「## 待拍板」小节的只读视图（extractOpenQuestions 纯逻辑）。
 *  挂载读一次简报全文（read_file_preview 根约束），无小节或无条目不渲染；
 *  点条目 = 带着这个问题去「聊想法」（沿用想法期只读保护口径） */
function OpenQuestions({
  projectPath,
  briefRel,
  onPick,
}: {
  projectPath: string;
  briefRel: string;
  onPick: (question: string) => void;
}) {
  const [questions, setQuestions] = useState<string[] | null>(null);
  useEffect(() => {
    let stale = false;
    const abs = `${projectPath.replace(/[\\/]+$/, "")}/${briefRel}`;
    invoke<{ text: string }>("read_file_preview", {
      path: abs,
      root: projectPath,
    })
      .then((p) => {
        if (!stale) setQuestions(extractOpenQuestions(p.text));
      })
      .catch(() => {
        if (!stale) setQuestions([]);
      });
    return () => {
      stale = true;
    };
  }, [projectPath, briefRel]);
  if (!questions || questions.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] text-l4">
        待拍板（{questions.length}）——来自最新简报，点了去聊
      </div>
      <ul className="space-y-0.5">
        {questions.map((q) => (
          <li key={q}>
            <button
              type="button"
              onClick={() => onPick(q)}
              title="开终端讨论这个问题（想法期只读保护同样生效）"
              className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              <span className="shrink-0 text-[10px] text-warn-text">?</span>
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
 * 任务卡区（项目详情，流水线步进器下方）：卡片 = 对话的文件夹 + 定稿简报的收集夹。
 * 按步骤分桶（失效步骤的卡并入「未挂步骤」桶）；行主动作 = 开工（挂步骤的卡，走一键开步链路，
 * 最新定稿简报注入 TASK.md）/ 继续（有定稿简报，开终端预填「阅读简报并继续」首条指令）。
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
  /** 卡片「开工」：打开开工确认弹层（originCardId = 出处卡，弹层内可选多卡简报/融合）；
      返回 Promise 供行内 busy 态跟随 */
  onStartStep: (index: number, originCardId?: string) => Promise<void> | void;
}) {
  const cards = useAppStore((s) => s.taskCards[projectPath]);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const createCard = useAppStore((s) => s.createCard);
  const renameCard = useAppStore((s) => s.renameCard);
  const deleteCard = useAppStore((s) => s.deleteCard);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
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
    // 步骤聚焦：只保留聚焦步骤的桶（「未挂步骤」桶在聚焦时隐藏——它不属于任何步骤）
    if (!focusStep) return all;
    return all.filter((b) => b.step === focusStep);
  })();
  /** 聚焦步骤的声明（人工事项清单/种子用）；聚焦名失效（步骤被删/改名）时 null → 聚焦桶为空 */
  const focusStepDto = focusStep
    ? (steps.find((s) => s.name === focusStep) ?? null)
    : null;
  // 聚焦步骤的任务书草稿（v3.72）：discuss 节点状态与「聊任务书」指令用
  const [focusDraft, setFocusDraft] = useState<{
    relPath: string;
    text: string | null;
  } | null>(null);
  useEffect(() => {
    if (!focusStep) {
      setFocusDraft(null);
      return;
    }
    let stale = false;
    invoke<{ relPath: string; text: string | null }>("read_task_draft", {
      projectRoot: projectPath,
      stepName: focusStep,
    })
      .then((d) => {
        if (!stale) setFocusDraft(d);
      })
      .catch(() => {
        if (!stale) setFocusDraft(null);
      });
    return () => {
      stale = true;
    };
  }, [projectPath, focusStep, refreshToken]);

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
        `删除卡片「${card.name}」？卡片内的对话会移出卡片（对话本身不删除），钉住的简报文件保留在磁盘。继续？`,
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

  /** 聊想法：项目根开终端（不建工作区——想法期不动手）。
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

  /** 开工：挂步骤的卡打开开工确认弹层（TASK.md 预览 + 简报来源勾选/融合），确认后才建工作区 */
  function onStart(card: TaskCardDto) {
    const index = steps.findIndex((s) => s.name === card.step);
    if (index < 0 || busyId) return;
    claimForCard(card);
    setBusyId(card.id);
    void Promise.resolve(onStartStep(index, card.id))
      .catch(() => {})
      .finally(() => setBusyId(null));
  }

  /** 讨论种子点击即聊（v3.72 任务书口径）：以种子问题为名建卡归档（已有同名卡则直接续聊），
      非只读启动——讨论出的结论 agent 直接写进任务书草稿（指令约束只许动这一个文件） */
  async function onSeed(stepName: string, seed: string) {
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
          `先聊这个问题：${seed}。讨论出的结论直接整理进这个草稿文件——只允许新建/修改这一个文件，其他文件一律不要动。`,
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

  /** 继续：开终端新会话，预填「阅读最新简报并继续」；目录 = 绑定工作区工作树（若有）否则项目根。
   *  kimi/opencode 无启动注入参数：启动栏保留指令文本由用户手动发送（pty_spawn promptDropped 既有处理） */
  function onContinue(card: TaskCardDto) {
    const brief = latestBrief(card);
    if (!brief) return;
    claimForCard(card);
    const ws = card.workspace
      ? workspaces.find(
          (w) => w.name === card.workspace && w.status === "active",
        )
      : undefined;
    const cwd = ws?.worktreePath ?? projectPath;
    // 简报存在项目根 .ccode/ 下：cwd 是工作树时相对路径够不到，用绝对路径
    const ref = ws
      ? `${projectPath.replace(/[\\/]+$/, "")}/${brief}`
      : brief;
    setPendingTerminal({
      cwd,
      extraEnv: {},
      title: card.name,
      initialPrompt: `阅读 ${ref} 简报并继续任务`,
    });
    setPage("terminal");
  }

  /** 步骤级「预览 TASK.md」：默认来源（无出处卡口径）拼装当前 TASK.md，只读展示；
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
    const sources = briefSourcesForStep(
      cards ?? [],
      stepName,
      steps.map((s) => s.name),
    );
    const refs = checkedBriefRefs(sources, defaultCheckedSources(sources, null));
    buildTaskMdPreview(projectPath, step, cfg, refs)
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

  function briefAbsPath(rel: string): string {
    return `${projectPath.replace(/[\\/]+$/, "")}/${rel}`;
  }

  function renderCard(card: TaskCardDto) {
    const canStart = card.step !== null && steps.some((s) => s.name === card.step);
    // 新卡片（无简报）= 想法期：常驻主按钮是「聊想法」；已有简报则「开工/继续」上位，聊想法收进 ⋯
    const fresh = card.briefs.length === 0;
    const expanded = open.has(card.id);
    // 行内 meta 小字：简报数 + 最新简报相对时间（不加新请求，会话数不显示）
    const latestTime = latestBrief(card)
      ? briefTimeFromPath(latestBrief(card)!)
      : null;
    const meta = fresh
      ? null
      : `简报 ${card.briefs.length}${latestTime ? ` · 最新 ${relTime(latestTime)}` : ""}`;
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover">
          <button
            type="button"
            onClick={() => toggleOpen(card.id)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={expanded ? "收起" : "展开（待拍板 / 简报）"}
          >
            <span className="w-3 shrink-0 text-[10px] text-l4">
              {expanded ? "▾" : "▸"}
            </span>
            <span className="min-w-0 truncate text-xs text-l1">
              {card.name}
            </span>
            {meta && (
              <span
                className="shrink-0 text-[10px] text-l4"
                title={latestTime ? absTime(latestTime) : undefined}
              >
                {meta}
              </span>
            )}
          </button>
          {fresh ? (
            <button
              type="button"
              onClick={() => onDiscuss(card)}
              title="在项目根开终端聊聊这张卡（不建工作区），新会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              聊想法
            </button>
          ) : canStart ? (
            <button
              type="button"
              disabled={busyId === card.id}
              onClick={() => onStart(card)}
              title="一键开步：建工作区并把最新定稿简报写进 TASK.md；会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              开始
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onContinue(card)}
              title="开终端新会话，预填「阅读最新简报并继续任务」；会话自动归入本卡"
              className={`${actionBtn} shrink-0`}
            >
              继续
            </button>
          )}
          <span className={`flex shrink-0 items-center gap-1 ${hoverRevealClass}`}>
            {fresh && canStart && (
              <button
                type="button"
                disabled={busyId === card.id}
                onClick={() => onStart(card)}
                title="跳过讨论直接开步：建工作区并预填步骤简报"
                className={actionBtn}
              >
                开始
              </button>
            )}
            {!fresh && canStart && (
              <button
                type="button"
                onClick={() => onContinue(card)}
                title="开终端新会话，预填「阅读最新简报并继续任务」；会话自动归入本卡"
                className={actionBtn}
              >
                继续
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
            {/* 待拍板问题（最新定稿简报「## 待拍板」小节的视图，无新存储）：点了带问题去聊想法 */}
            {latestBrief(card) && (
              <OpenQuestions
                projectPath={projectPath}
                briefRel={latestBrief(card)!}
                onPick={(q) => onDiscuss(card, false, q)}
              />
            )}
            {card.briefs.length === 0 ? (
              <p className="text-xs text-l4">还没有简报</p>
            ) : (
              <ul className="space-y-0.5">
                {/* briefs 时间序，展示最新在前 */}
                {card.briefs
                  .slice()
                  .reverse()
                  .map((rel) => {
                    const time = briefTimeFromPath(rel);
                    return (
                      <li key={rel}>
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewReq({
                              path: briefAbsPath(rel),
                              name: baseName(rel),
                              root: projectPath,
                            });
                            setPage("terminal");
                          }}
                          title={`在终端页预览 ${rel}`}
                          className="flex h-7 w-full items-center gap-2 rounded-sm px-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                        >
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {rel}
                          </span>
                          {time && (
                            <span
                              className="shrink-0 text-[10px] text-l4"
                              title={absTime(time)}
                            >
                              {relTime(time)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
              </ul>
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
            className="ml-auto shrink-0 rounded-sm bg-inset px-1.5 py-0.5 text-[10px] text-warn-text hover:bg-hover"
          >
            主仓 {mainDirty} 个未提交改动
          </button>
        )}
        {/* 想法期只读保护（默认开，存 settings.json）：开 = 聊想法注入只读/计划模式参数（支持的 CLI）
            + 预填不动文件约束；关 = 纯聊天。设置页不加行，就地开关 */}
        <span
          className={`flex shrink-0 items-center gap-1.5 ${mainDirty ? "" : "ml-auto"}`}
          title="开启后，「聊想法」会以只读/计划模式启动 Agent（支持该参数的 CLI），并嘱咐它只讨论不动文件"
        >
          <span className="text-[10px] text-l4">想法期只读保护</span>
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
      {/* 空态即教学：还没有卡片时用一行白话讲清工作流（不做教程页）。
          聚焦时不显示（聚焦本身已是引导） */}
      {!focusStep && cards && cards.length === 0 && (
        <p className="mt-1 rounded-md bg-inset px-2.5 py-2 text-[13px] text-l4">
          点步骤下的种子问题开聊 → 结论直接写进任务书草稿 →
          开工时草稿就是 TASK.md。卡片只负责归档这些讨论。
        </p>
      )}
      {error && <p className="mt-1 text-xs text-err-text">{error}</p>}
      {/* 聚焦头部：步骤名 + 状态短语（父级 describeStep 口径）+ 总览切换。
          聚焦态下步骤名只出现在这里与流程线 agent 节点，桶头不再重复 */}
      {focusStep && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-sm font-medium text-l1">{focusStep}</span>
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
        <div className="mt-1">
          {/* 步骤内协同流程线（v3.71）：人/agent 动作按先后排成节点链，当前节点就地操作 */}
          <StepFlow
            projectPath={projectPath}
            step={focusStepDto}
            runStatus={focusRunStatus ?? "pending"}
            hasBrief={
              (cards ?? []).some(
                (c) => c.step === focusStepDto.name && c.briefs.length > 0,
              ) || !!focusDraft?.text?.trim()
            }
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
                title="预览该步骤当前 TASK.md 拼装结果（模板简报 + 默认来源简报 + 提货单）"
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
                <span className="text-[13px] text-l2">
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
                  <span className="text-[10px] text-l4">开工前聊聊：</span>
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
                            : "点击就这个问题开聊（自动建卡，只读保护生效）"
                        }
                        className="rounded-full bg-inset px-2 py-0.5 text-[11px] text-l3 hover:bg-hover hover:text-l1"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
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
            />
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-field bg-canvas">
              {taskMdPreview.text === null ? (
                <div className="p-3">
                  <LoadingRows compact />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-l2">
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            // 已有简报的卡片：聊想法降为低频入口（新卡片它已是行内主按钮）
            ...(menu.card.briefs.length > 0
              ? [
                  {
                    label: "聊想法",
                    title:
                      "在项目根开终端聊聊这张卡（不建工作区），新会话自动归入本卡",
                    onSelect: () => onDiscuss(menu.card),
                  },
                ]
              : []),
            // 单次豁免：不动「想法期只读保护」开关，本次允许 Agent 改文件（开关关时无意义不渲染）
            ...(discussGuard
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
