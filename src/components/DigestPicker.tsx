import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import type { HandoffBriefDto, HandoffTargetDto } from "../types";
import type { HandoffSource } from "./HandoffPicker";

function agentLabel(id: string): string {
  return AGENTS.find((a) => a.id === id)?.label ?? id;
}

/**
 * 「◈ 提炼接力…」目标选择器：AI 把全会话蒸馏成紧凑的结构化简报落盘，
 * 新会话只读简报续作（不带旧上下文，非完整记忆）。三路径消费：
 * 内部同 Agent 新会话 / 内部其他 Agent / 外部（⧉ 复制命令、⇗ 外部终端）。
 * 骨架与 HandoffPicker 一致；kimi/opencode 无启动注入参数，走手动发送停留态。
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
  const [targets, setTargets] = useState<HandoffTargetDto[] | null>(null);
  const [brief, setBrief] = useState<HandoffBriefDto | null>(null);
  const [generating, setGenerating] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 外部命令/指令的已复制反馈（按目标 agent 区分）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // kimi/opencode 无启动注入：简报就绪后停留展示手动发送提示
  const [ready, setReady] = useState<{
    target: HandoffTargetDto;
    prompt: string;
  } | null>(null);

  const generate = useCallback(() => {
    setGenerating(true);
    setError(null);
    invoke<HandoffBriefDto>("build_session_digest", {
      agent: source.agent,
      sessionId: source.sessionId,
      filePath: source.filePath,
      cwd: source.cwd,
      title: source.title,
      targetPath: null,
    })
      .then(setBrief)
      .catch((e) => setError(String(e)))
      .finally(() => setGenerating(false));
  }, [source]);

  useEffect(() => {
    generate();
    invoke<HandoffTargetDto[]>("handoff_targets")
      .then(setTargets)
      .catch((e) => setError(String(e)));
  }, [generate]);

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
    if (!brief) return;
    setBusy(t.id);
    setError(null);
    try {
      await invoke("mark_handoff", {
        targetAgent: t.id,
        targetCwd: source.cwd,
        fromAgent: source.agent,
        fromSessionId: source.sessionId,
      });
      const prompt = promptFor(brief);
      if (t.promptSupported) {
        goTerminal(t, prompt);
      } else {
        // 无交互注入参数（kimi/opencode）：复制指令文本，停留展示提示，由用户确认后前往
        await navigator.clipboard.writeText(prompt).catch(() => {});
        setReady({ target: t, prompt });
        setBusy(null);
      }
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  /** ⧉ 复制外部续作命令；Unsupported 目标复制指令文本（启动后手动粘贴） */
  async function copyExternal(t: HandoffTargetDto) {
    if (!brief) return;
    try {
      const prompt = promptFor(brief);
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
      setError(String(e));
    }
  }

  /** ⇗ 在外部终端以「读简报续作」开新会话（仅支持注入的目标） */
  async function openExternal(t: HandoffTargetDto) {
    if (!brief) return;
    try {
      await invoke("digest_external_terminal", {
        agentId: t.id,
        cwd: source.cwd,
        prompt: promptFor(brief),
      });
    } catch (e) {
      setError(String(e));
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
        className="absolute top-1/4 left-1/2 w-96 -translate-x-1/2 rounded border border-field bg-strip py-2 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pb-2">
          <p className="font-medium text-l1">◈ 提炼接力…</p>
          <p className="mt-1 text-xs text-l4">
            AI 把全会话提炼成紧凑简报（非完整记忆），新会话读简报续作，不带旧上下文。
          </p>
          <p className="mt-1.5 text-xs">
            {generating ? (
              <span className="text-l4">⏳ 正在提炼会话…</span>
            ) : brief ? (
              <span className="text-ok-text">
                ✓ {brief.summary} → {relPath(brief.filePath)}
              </span>
            ) : null}
          </p>
        </div>
        {error && (
          <div className="px-3 pb-1">
            <p className="text-xs text-err-text">{error}</p>
            {!generating && !brief && (
              <button
                className="mt-1 rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5 hover:text-l1"
                onClick={generate}
              >
                重试
              </button>
            )}
          </div>
        )}
        {ready ? (
          <div className="px-3 pb-1">
            <p className="text-xs text-warn-text">
              {agentLabel(ready.target.id)}{" "}
              不支持启动注入：简报指令已复制，启动后请手动发送（终端启动栏会保留该指令文本）。
            </p>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded border border-cta-bd bg-cta px-2.5 py-1 text-xs text-cta-text hover:brightness-110"
                onClick={() => goTerminal(ready.target, ready.prompt)}
              >
                前往终端启动
              </button>
              <button
                className="rounded px-2.5 py-1 text-xs text-l3 hover:bg-white/5 hover:text-l1"
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
                aria-disabled={!t.installed || !brief || busy !== null}
                onClick={() => {
                  if (t.installed && brief && busy === null) void pick(t);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && t.installed && brief && busy === null)
                    void pick(t);
                }}
                className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-l2 hover:bg-white/5 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
                {t.installed && brief && (
                  <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      className="rounded px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
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
                        className="rounded px-1 py-0.5 text-xs text-l4 hover:bg-white/10 hover:text-l1"
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
        )}
      </div>
    </div>
  );
}
