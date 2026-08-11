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
  /** 排序优先级，数字越小越靠前（见 itemRank） */
  rank: number;
}

export interface RunOverviewSummary {
  /** 待确认 */
  confirm: number;
  /** 工作中 */
  working: number;
}

/** 路径尾段（项目名 / 工作区名）；空路径返回空串，纯 "~" 原样返回 */
export function cwdBasename(p: string): string {
  if (!p) return "";
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 「要你管」排序：待确认 > 工作中 > 其余 agent 运行中 > shell / 已退出。
 *  「已回复」（done）不占档——回合结束不阻塞决策，归入普通运行/退出档 */
export function itemRank(input: RunOverviewInput): number {
  if (input.attention === "confirm") return 0;
  if (input.attention === "working") return 1;
  if (input.running) return 2;
  return 3;
}

/** 汇总全部终端标签：按「要你管」优先级稳定排序（同级保持标签原有顺序），并统计摘要 */
export function buildRunOverview(inputs: RunOverviewInput[]): {
  items: RunOverviewItem[];
  summary: RunOverviewSummary;
} {
  const items: RunOverviewItem[] = inputs.map((input) => ({
    ...input,
    cwdLabel: cwdBasename(input.cwd),
    rank: itemRank(input),
  }));
  // Array.prototype.sort 稳定：同 rank 保持传入顺序（即标签条顺序）
  items.sort((a, b) => a.rank - b.rank);
  const summary: RunOverviewSummary = { confirm: 0, working: 0 };
  for (const it of items) {
    if (it.attention === "confirm") summary.confirm++;
    else if (it.attention === "working") summary.working++;
  }
  return { items, summary };
}

/** 项目归属根：repoPath + 各工作区 worktreePath（终端 cwd 落在工作树内也归该项目） */
export interface ProjectRoot {
  key: string;
  roots: string[];
}

/** 把路径归属到项目（分隔符归一 + 段边界的最长前缀命中）；不命中任何项目返回 null。
 *  工作区页项目导航的「待处理」计数用它把终端/外部会话的注意力事项摊到项目上。 */
export function attributeToProject(
  path: string,
  groups: readonly ProjectRoot[],
): string | null {
  const target = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!target) return null;
  let best: { key: string; len: number } | null = null;
  for (const g of groups) {
    for (const r of g.roots) {
      const root = r.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!root) continue;
      // 段边界：root 本身或 root/ 前缀（防 /repo/proj 误中 /repo/proj2）
      if (target === root || target.startsWith(`${root}/`)) {
        if (!best || root.length > best.len) best = { key: g.key, len: root.length };
      }
    }
  }
  return best?.key ?? null;
}
