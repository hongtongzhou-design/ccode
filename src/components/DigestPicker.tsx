import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import type { HandoffBriefDto, HandoffTargetDto } from "../types";
import type { HandoffSource } from "./HandoffPicker";

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

/**
 * 「◈ 提炼接力…」目标选择器：AI 把全会话蒸馏成紧凑的结构化简报，
 * 新会话只读简报续作（不带旧上下文，非完整记忆）。两段流程：
 * 定稿页（AI 初稿可编辑，「定稿并继续」落盘 .ccode/brief-*.md 并钉入会话所属任务卡）
 * → 发送页（目标 Agent 列表，一律发送定稿路径；AI 初稿的 handoff-*.md 留在磁盘不再使用）。
 * 三路径消费：内部同 Agent 新会话 / 内部其他 Agent / 外部（⧉ 复制命令、⇗ 外部终端）。
 * 骨架与 HandoffPicker 一致；kimi/opencode 无启动注入参数，走手动发送停留态。
 * 生成走 store.digestJob 后台任务（v3.60）：关闭本弹窗不中断、重开复用结果不重复提炼；
 * ready 未消费时收件箱挂「待发送」条目；已定稿（digestJob.finalized）重开直达发送页。
 */
export default function DigestPicker({
  source,
  onClose,
}: {
  source: HandoffSource;
  onClose: () => void;
}) {
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  const profiles = useAppStore((s) => s.profiles);
  const sessions = useAppStore((s) => s.sessions);
  const digestJob = useAppStore((s) => s.digestJob);
  const startDigestJob = useAppStore((s) => s.startDigestJob);
  const consumeDigestJob = useAppStore((s) => s.consumeDigestJob);
  const setDigestFinalized = useAppStore((s) => s.setDigestFinalized);
  const loadTaskCards = useAppStore((s) => s.loadTaskCards);
  const [targets, setTargets] = useState<HandoffTargetDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  // 定稿页：AI 初稿全文（可编辑）与落盘状态
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 外部命令/指令的已复制反馈（按目标 agent 区分）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // kimi/opencode 无启动注入：简报就绪后停留展示手动发送提示
  const [ready, setReady] = useState<{
    target: HandoffTargetDto;
    prompt: string;
  } | null>(null);

  // 依赖原始字段而非 source 对象：调用方在 JSX 里内联构造 source，
  // 父级任何重渲染都会换新对象身份，若按对象依赖会反复重新提炼
  const { agent, sessionId, filePath, cwd, title } = source;
  // 本弹窗对应的任务：同会话复用（含 picker 关闭期间在后台跑完的结果）
  const job =
    digestJob &&
    digestJob.agent === agent &&
    digestJob.sessionId === sessionId &&
    digestJob.filePath === filePath
      ? digestJob
      : null;
  const generating = job?.status !== "ready" && job?.status !== "error";
  const brief = job?.status === "ready" ? (job.brief ?? null) : null;
  // 定稿后发送一律用定稿产物（save_task_brief 落盘的 brief-*.md），AI 初稿仅作编辑底本
  const finalized = job?.finalized ?? null;
  const effectiveBrief = finalized ?? brief;
  const error = localError ?? (job?.status === "error" ? (job.error ?? null) : null);

  useEffect(() => {
    startDigestJob({ agent, sessionId, filePath, cwd, title });
    invoke<HandoffTargetDto[]>("handoff_targets")
      .then(setTargets)
      .catch((e) => setLocalError(String(e)));
  }, [agent, sessionId, filePath, cwd, title, startDigestJob]);

  // 定稿页底本：读 AI 初稿全文进编辑框（已定稿则跳过，直达发送页）
  const draftPath = brief && !finalized ? brief.filePath : null;
  useEffect(() => {
    if (!draftPath) return;
    let stale = false;
    invoke<{ text: string; truncated: boolean }>("read_file_preview", {
      path: draftPath,
      root: cwd,
    })
      .then((p) => {
        if (!stale) setDraft(p.text);
      })
      .catch((e) => {
        if (!stale) setLocalError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [draftPath, cwd]);

  /** 会话所属任务卡（归置过才钉卡；名称用于定稿页提示） */
  const sourceTask = sessions.find(
    (s) => s.agent === agent && s.sessionId === sessionId,
  );

  /** 定稿落盘：save_task_brief 写入项目 .ccode/brief-*.md（已脱敏+上限），
   *  会话已归置卡片时钉进卡片；continueSend = 定稿后进发送页，否则仅落盘钉卡并关闭 */
  async function finalize(continueSend: boolean) {
    if (!job || draft === null || saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      const taskId = sourceTask?.taskId ?? null;
      const rel = await invoke<string>("save_task_brief", {
        projectRoot: cwd,
        taskId,
        content: draft,
      });
      const abs = `${cwd.replace(/[\\/]+$/, "")}/${rel}`;
      setDigestFinalized({
        filePath: abs,
        summary: brief?.summary ?? "已定稿",
      });
      // 钉卡后刷新卡片缓存（工作区页卡片区/对话页分组同源）
      if (taskId) void loadTaskCards(cwd).catch(() => {});
      if (!continueSend) {
        consumeDigestJob();
        onClose();
      }
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // Escape 关闭（同 HandoffPicker 语义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** 简报路径相对项目目录（默认落 cwd/.ccode/ 下），指令里用相对路径 */
  function relPath(filePath: string): string {
    const root = source.cwd.replace(/[\\/]+$/, "");
    return filePath.startsWith(`${root}/`)
      ? filePath.slice(root.length + 1)
      : filePath;
  }

  function promptFor(b: HandoffBriefDto): string {
    return `读 ${relPath(b.filePath)} 接力简报，在此基础上继续完成任务`;
  }

  /** 开新终端标签预填启动（同 cwd、目标 agent、读简报指令为首条 prompt） */
  function goTerminal(target: HandoffTargetDto, prompt: string) {
    const profileId =
      localStorage.getItem(`ccode.lastProfile.${target.id}`) ??
      profiles.find((p) => p.agent === target.id)?.id;
    setPendingTerminal({
      cwd: source.cwd,
      extraEnv: {},
      title: `提炼接力 → ${agentLabel(target.id)}`,
      agentId: target.id,
      profileId,
      initialPrompt: prompt,
    });
    setPage("terminal");
    onClose();
  }

  /** 内部启动：登记接力链（⇄ 接自 badge 沿用）后按注入能力分流 */
  async function pick(t: HandoffTargetDto) {
    if (!effectiveBrief) return;
    setBusy(t.id);
    setLocalError(null);
    try {
      await invoke("mark_handoff", {
        targetAgent: t.id,
        targetCwd: source.cwd,
        fromAgent: source.agent,
        fromSessionId: source.sessionId,
      });
      const prompt = promptFor(effectiveBrief);
      // 已选定发送目标：简报任务标记已消费，收件箱「待发送」摘除
      consumeDigestJob();
      if (t.promptSupported) {
        goTerminal(t, prompt);
      } else {
        // 无交互注入参数（kimi/opencode）：复制指令文本，停留展示提示，由用户确认后前往
        await navigator.clipboard.writeText(prompt).catch(() => {});
        setReady({ target: t, prompt });
        setBusy(null);
      }
    } catch (e) {
      setLocalError(String(e));
      setBusy(null);
    }
  }

  /** ⧉ 复制外部续作命令；Unsupported 目标复制指令文本（启动后手动粘贴） */
  async function copyExternal(t: HandoffTargetDto) {
    if (!effectiveBrief) return;
    try {
      const prompt = promptFor(effectiveBrief);
      const text = t.promptSupported
        ? await invoke<string>("session_digest_command", {
            agentId: t.id,
            cwd: source.cwd,
            prompt,
          })
        : prompt;
      await navigator.clipboard.writeText(text);
      setCopiedId(t.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      setLocalError(String(e));
    }
  }

  /** ⇗ 在外部终端以「读简报续作」开新会话（仅支持注入的目标） */
  async function openExternal(t: HandoffTargetDto) {
    if (!effectiveBrief) return;
    try {
      await invoke("digest_external_terminal", {
        agentId: t.id,
        cwd: source.cwd,
        prompt: promptFor(effectiveBrief),
      });
    } catch (e) {
      setLocalError(String(e));
    }
  }

  // 排序：来源 agent 置顶（同 Agent 新会话），其余按 已安装+支持注入 → 已安装需手动 → 未安装
  const sorted = (targets ?? [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.id === source.agent) - Number(a.id === source.agent) ||
        Number(b.installed) - Number(a.installed) ||
        Number(b.promptSupported) - Number(a.promptSupported) ||
        AGENTS.findIndex((x) => x.id === a.id) -
          AGENTS.findIndex((x) => x.id === b.id),
    );

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        className={`absolute top-[12%] left-1/2 -translate-x-1/2 rounded-sm border border-field ccode-float-surface py-2 text-sm ${
          brief && !finalized ? "w-[36rem]" : "w-96"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pb-2">
          <p className="font-medium text-l1">◈ 提炼接力…</p>
          <p className="mt-1 text-xs text-l4">
            AI 把全会话提炼成紧凑简报（非完整记忆），新会话读简报续作，不带旧上下文。
          </p>
          <p className="mt-1.5 text-xs">
            {generating ? (
              <span className="text-l4">
                ⏳ 正在后台提炼会话…可关闭本窗口，完成后在「待你处理」出现
              </span>
            ) : finalized ? (
              <span className="text-ok-text">
                ✓ 已定稿 → {relPath(finalized.filePath)}
              </span>
            ) : null}
          </p>
        </div>
        {error && (
          <div className="px-3 pb-1">
            <p className="text-xs text-err-text">{error}</p>
            {!generating && !brief && (
              <button
                className="mt-1 rounded-sm px-2 py-0.5 text-xs text-l3 hover:bg-hover hover:text-l1"
                onClick={() =>
                  startDigestJob({ agent, sessionId, filePath, cwd, title }, true)
                }
              >
                重试
              </button>
            )}
          </div>
        )}
        {/* 定稿页：AI 初稿进编辑框，定稿才落盘（钉入会话所属任务卡）；「暂不发送」= 仅定稿落盘 */}
        {brief && !finalized && (
          <div className="px-3 pb-2">
            <p className="pb-1.5 text-xs text-l4">
              AI 初稿，改完定稿后才会落盘
              {sourceTask?.taskName
                ? `；将钉入任务卡「${sourceTask.taskName}」`
                : ""}
            </p>
            <textarea
              className="h-72 w-full resize-none rounded-md border border-field bg-inset px-2 py-1.5 text-[13px] leading-relaxed text-l2 outline-none placeholder:text-l4 focus:border-l4"
              value={draft ?? ""}
              disabled={draft === null || saving}
              placeholder={draft === null ? "读取初稿中…" : ""}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={saving || draft === null || !draft.trim()}
                onClick={() => void finalize(true)}
                title="定稿落盘（钉入任务卡）后选择目标 Agent 发送"
                className="rounded-sm border border-cta-bd bg-cta px-2.5 py-1 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {saving ? "定稿中…" : "定稿并继续"}
              </button>
              <button
                type="button"
                disabled={saving || draft === null || !draft.trim()}
                onClick={() => void finalize(false)}
                title="仅定稿落盘钉卡，不发送；收件箱「待发送」摘除"
                className="rounded-sm px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1 disabled:opacity-50"
              >
                暂不发送
              </button>
            </div>
          </div>
        )}
        {/* 发送页（已定稿）：目标列表与外部路径一律用定稿简报 */}
        {finalized && !ready && (
          <div className="px-3 pb-1">
            <button
              className="rounded-sm px-2 py-0.5 text-xs text-l4 hover:bg-hover hover:text-l2"
              title="暂不发送：简报文件保留在磁盘，收件箱条目摘除"
              onClick={() => {
                consumeDigestJob();
                onClose();
              }}
            >
              暂不发送
            </button>
          </div>
        )}
        {finalized &&
          (ready ? (
          <div className="px-3 pb-1">
            <p className="text-xs text-warn-text">
              {agentLabel(ready.target.id)}{" "}
              不支持启动注入：简报指令已复制，启动后请手动发送（终端启动栏会保留该指令文本）。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded-sm border border-cta-bd bg-cta px-2.5 py-1 text-xs text-cta-text hover:brightness-110"
                onClick={() => goTerminal(ready.target, ready.prompt)}
              >
                前往终端启动
              </button>
              <button
                className="rounded-sm px-2.5 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
                onClick={onClose}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="pb-1">
            {targets === null && !error && (
              <p className="px-3 py-1 text-xs text-l4">检测目标 Agent…</p>
            )}
            {sorted.map((t) => (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                aria-disabled={!t.installed || busy !== null}
                onClick={() => {
                  if (t.installed && busy === null) void pick(t);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && t.installed && busy === null)
                    void pick(t);
                }}
                className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-l2 hover:bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">
                  {busy === t.id ? "登记接力…" : agentLabel(t.id)}
                  {t.id === source.agent && (
                    <span className="ml-1.5 text-xs text-l4">
                      同 Agent · 新会话
                    </span>
                  )}
                </span>
                {!t.installed && (
                  <span className="shrink-0 text-xs text-l4">未安装</span>
                )}
                {t.installed && !t.promptSupported && (
                  <span className="shrink-0 text-xs text-l4">需手动发送</span>
                )}
                {t.installed && (
                  <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      className="rounded-sm px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
                      title={
                        t.promptSupported
                          ? "复制外部终端续作命令（新会话读简报，非恢复旧会话）"
                          : "该 CLI 无启动注入参数：复制简报指令，外部启动后手动粘贴"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyExternal(t);
                      }}
                    >
                      {copiedId === t.id ? "✓ 已复制" : "⧉"}
                    </button>
                    {t.promptSupported && (
                      <button
                        className="rounded-sm px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
                        title="在外部终端以「读简报续作」开新会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          void openExternal(t);
                        }}
                      >
                        ⇗
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
