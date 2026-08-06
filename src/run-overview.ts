/**
 * 运行中总览（P5 聚合视图）的聚合/排序纯逻辑。
 * 输入全部由终端页现有 statuses 上报派生（TerminalView 本地轮询后镜像），
 * 不新增任何后端轮询；node --test 可直接单测。
 */

/** 聚合输入的单项：TerminalPage 从 tabs + statuses 派生（无状态的标签由调用方填默认值） */
export interface RunOverviewInput {
  tabId: string;
  title: string;
  agentId: string;
  model: string;
  cwd: string;
  /** agent 正在运行 */
  running: boolean;
  /** 当前接的是 shell（有存活 PTY） */
  shell: boolean;
  /** 会话尾部注意力状态；无联动 / shell / 已退出 / 未知为 null */
  attention: "done" | "working" | "confirm" | null;
}

export interface RunOverviewItem extends RunOverviewInput {
  /** cwd 尾段（项目名 / 工作区名），缩短显示用 */
  cwdLabel: string;
  /** 「已完成」已被点击查看过（本次会话内），不再计入「要你管」 */
  seenDone: boolean;
  /** 排序优先级，数字越小越靠前（见 itemRank） */
  rank: number;
}

export interface RunOverviewSummary {
  /** 待确认 */
  confirm: number;
  /** 已完成且未查看 */
  done: number;
  /** 工作中 */
  working: number;
}

/** 路径尾段（项目名 / 工作区名）；空路径返回空串，纯 "~" 原样返回 */
export function cwdBasename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 「要你管」排序：待确认 > 已完成(未查看) > 工作中 > 其余 agent 运行中 > shell / 已退出 */
export function itemRank(input: RunOverviewInput, seenDone: boolean): number {
  if (input.attention === "confirm") return 0;
  if (input.attention === "done" && !seenDone) return 1;
  if (input.attention === "working") return 2;
  if (input.running) return 3;
  return 4;
}

/** 汇总全部终端标签：按「要你管」优先级稳定排序（同级保持标签原有顺序），并统计摘要 */
export function buildRunOverview(
  inputs: RunOverviewInput[],
  seenDone: ReadonlySet<string>,
): { items: RunOverviewItem[]; summary: RunOverviewSummary } {
  const items: RunOverviewItem[] = inputs.map((input) => {
    const seen = input.attention === "done" && seenDone.has(input.tabId);
    return {
      ...input,
      cwdLabel: cwdBasename(input.cwd),
      seenDone: seen,
      rank: itemRank(input, seen),
    };
  });
  // Array.prototype.sort 稳定：同 rank 保持传入顺序（即标签条顺序）
  items.sort((a, b) => a.rank - b.rank);
  const summary: RunOverviewSummary = { confirm: 0, done: 0, working: 0 };
  for (const it of items) {
    if (it.attention === "confirm") summary.confirm++;
    else if (it.attention === "done" && !it.seenDone) summary.done++;
    else if (it.attention === "working") summary.working++;
  }
  return { items, summary };
}
