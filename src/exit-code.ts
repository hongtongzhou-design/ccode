/**
 * 进程退出码的白话解释。
 *
 * 后端 `pty.rs` 在子进程回收后把 `status.exit_code()` 作为 `pty-exit-<id>` 事件的
 * payload 发出来；前端早先丢掉了这个形参，用户只能看到「进程已退出」，分不清
 * 正常结束、Ctrl-C、被 OOM 杀掉还是自己点错了停止。
 *
 * `-1` 是后端的「原因未知」哨兵：`pty_kill`（用户主动停止）、`discard_spawned_pty`
 * 和 wait 超时三条路径都发 -1。它**不**代表崩溃，所以文案要中性，不能染红。
 */

export type ExitTone = "ok" | "warn" | "err" | "muted";

export interface ExitCodeSummary {
  /** 状态行文本，接在「进程」之后也自成一句，如「被中断（Ctrl-C）」 */
  label: string;
  /** 紧凑状态行的 ` · ` 后缀 */
  short: string;
  /** 数字退出码；原因未知时 null，界面不显示假数字 */
  code: number | null;
  tone: ExitTone;
}

/** 128 + 信号号：shell 对「被信号杀死」的惯例编码。 */
const SIGNAL_EXITS: Record<number, { label: string; tone: ExitTone }> = {
  129: { label: "被挂起（SIGHUP）", tone: "warn" },
  130: { label: "被中断（Ctrl-C）", tone: "warn" },
  131: { label: "被退出（SIGQUIT）", tone: "err" },
  137: { label: "被强制结束（SIGKILL）", tone: "err" },
  143: { label: "被终止（SIGTERM）", tone: "warn" },
};

export function exitCodeSummary(code: number): ExitCodeSummary {
  // -1（及任何负数）：主动停止 / 回收 / wait 超时，无法区分谁杀的，
  // 如实说「已结束」，不给假退出码，也不染红。
  if (!Number.isFinite(code) || code < 0) {
    return { label: "已结束", short: "已结束", code: null, tone: "muted" };
  }
  if (code === 0) {
    return { label: "已正常退出", short: "已正常退出", code: 0, tone: "ok" };
  }
  if (code === 126) {
    return { label: "不可执行（权限不足）", short: "退出码 126", code, tone: "err" };
  }
  if (code === 127) {
    return { label: "未找到命令", short: "退出码 127", code, tone: "err" };
  }
  const sig = SIGNAL_EXITS[code];
  if (sig) return { label: sig.label, short: `退出码 ${code}`, code, tone: sig.tone };
  return {
    label: `异常退出（退出码 ${code}）`,
    short: `退出码 ${code}`,
    code,
    tone: "err",
  };
}

/** tone → 文字色类名。 */
export function exitToneClass(tone: ExitTone): string {
  if (tone === "ok") return "text-ok-text";
  if (tone === "warn") return "text-warn-text";
  if (tone === "err") return "text-err-text";
  return "text-l3";
}

/**
 * 回落 shell 那行提示里要加的括号子句。正常退出和原因未知都不加——
 * 「退出码 0」「退出码 -1」对用户是噪音，那行只需说会话已保存。
 */
export function exitCodeClause(code: number): string | null {
  if (!Number.isFinite(code) || code <= 0) return null;
  return `退出码 ${code}`;
}
