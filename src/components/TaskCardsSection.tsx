import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { hoverRevealClass } from "./PageFrame";
import { useAppStore } from "../store";
import { absTime, relTime } from "../rel-time";
import {
  briefTimeFromPath,
  bucketCardsByStep,
  latestBrief,
} from "../task-cards";
import type { ProjectStepDto, TaskCardDto, WorkspaceDto } from "../types";

const actionBtn =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-50";
const fieldSm =
  "h-7 rounded-md border border-field bg-canvas px-2 text-xs text-l2 outline-none placeholder:text-l4 focus:border-l4";

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
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
  workspaces,
  refreshToken,
  onStartStep,
}: {
  projectPath: string;
  steps: ProjectStepDto[];
  workspaces: WorkspaceDto[];
  /** 页面刷新令牌：评审沉淀等页外写入后随刷新重读 */
  refreshToken: number;
  /** 卡片「开工」：走 ProjectGroup 的开步链路（briefPath = 最新定稿简报，相对项目根）；
      返回 Promise 供行内 busy 态跟随链路结束 */
  onStartStep: (index: number, briefPath?: string) => Promise<void>;
}) {
  const cards = useAppStore((s) => s.taskCards[projectPath]);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const createCard = useAppStore((s) => s.createCard);
  const renameCard = useAppStore((s) => s.renameCard);
  const deleteCard = useAppStore((s) => s.deleteCard);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  const setPage = useAppStore((s) => s.setPage);
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

  useEffect(() => {
    let stale = false;
    loadTaskCards(projectPath).catch((e) => {
      if (!stale) setError(String(e));
    });
    return () => {
      stale = true;
    };
  }, [projectPath, refreshToken, loadTaskCards]);

  const buckets = bucketCardsByStep(
    cards ?? [],
    steps.map((s) => s.name),
  );

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

  /** 聊想法：项目根开终端（不建工作区——想法期不动手），预填一句开口引导帮用户起头；
   *  kimi/opencode 无启动注入参数：启动栏保留指令文本由用户手动发送（promptDropped 既有处理） */
  function onDiscuss(card: TaskCardDto) {
    claimForCard(card);
    setPendingTerminal({
      cwd: projectPath,
      extraEnv: {},
      title: card.name,
      initialPrompt: `我想跟你探讨：${card.name}`,
    });
    setPage("terminal");
  }

  /** 开工：挂步骤的卡走一键开步；最新定稿简报（若有）注入 TASK.md。busy 跟随链路结束（防连点重复开步） */
  function onStart(card: TaskCardDto) {
    const index = steps.findIndex((s) => s.name === card.step);
    if (index < 0 || busyId) return;
    claimForCard(card);
    setBusyId(card.id);
    void onStartStep(index, latestBrief(card) ?? undefined)
      .catch(() => {})
      .finally(() => setBusyId(null));
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
    const brief = latestBrief(card);
    const canStart = card.step !== null && steps.some((s) => s.name === card.step);
    // 新卡片（无简报）= 想法期：常驻主按钮是「聊想法」；已有简报则「开工/继续」上位，聊想法收进 ⋯
    const fresh = card.briefs.length === 0;
    const expanded = open.has(card.id);
    return (
      <li key={card.id} className="group">
        <div className="flex h-7 min-w-0 items-center gap-2 rounded px-1 hover:bg-white/5">
          <button
            type="button"
            onClick={() => toggleOpen(card.id)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={expanded ? "收起简报列表" : "展开简报列表"}
          >
            <span className="w-3 shrink-0 text-[10px] text-l4">
              {expanded ? "▾" : "▸"}
            </span>
            <span className="min-w-0 truncate text-xs text-l1">
              {card.name}
            </span>
            <span className="shrink-0 text-[10px] text-l4">
              {card.briefs.length > 0 ? `${card.briefs.length} 简报` : ""}
            </span>
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
              开工
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
                开工
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
              className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
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
          <div className="mb-1 ml-6 rounded-md bg-strip p-2">
            {card.briefs.length === 0 ? (
              <p className="text-xs text-l4">
                还没有定稿简报——先「聊想法」跟 Agent 聊透，对话页 ◈ 提炼接力定稿后钉到本卡片。
              </p>
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
                          className="flex h-7 w-full items-center gap-2 rounded px-1 text-left text-xs text-l2 hover:bg-white/5 hover:text-l1"
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
        <span className="text-[10px] text-l4">
          对话的文件夹 + 定稿简报的收集夹
        </span>
      </div>
      {/* 空态即教学：还没有卡片时用一行白话讲清工作流（不做教程页）；符号仅沿用既有 ◈=AI */}
      {cards && cards.length === 0 && (
        <p className="mt-1 rounded-md bg-inset px-2.5 py-2 text-[13px] text-l4">
          有想法？建张卡片 → 先跟 Agent 聊透 → ◈
          提炼定稿 → 再开工，简报会自动注入下一步任务。
        </p>
      )}
      {error && <p className="mt-1 text-xs text-err-text">{error}</p>}
      <div className="mt-1 space-y-2">
        {buckets.map((bucket) => {
          const key = bucket.step ?? "";
          return (
            <div key={key || "__unattached__"}>
              <div className="flex h-7 items-center gap-2">
                <span className="text-[10px] text-l4">
                  {bucket.step ?? "未挂步骤"}
                </span>
                {creatingIn === key ? (
                  <form
                    onSubmit={(e) => void submitCreate(bucket.step, e)}
                    className="flex min-w-0 flex-1 items-center gap-1"
                  >
                    <input
                      className={`${fieldSm} min-w-0 flex-1`}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="卡片名，如 方法对比整理"
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
                  <button
                    type="button"
                    onClick={() => {
                      setDraftName("");
                      setCreatingIn(key);
                    }}
                    className={`${actionBtn} text-l4 hover:text-l1`}
                  >
                    ＋ 新建卡片
                  </button>
                )}
              </div>
              {bucket.cards.length > 0 && (
                <ul className="divide-y divide-hairline">
                  {bucket.cards.map(renderCard)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
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
