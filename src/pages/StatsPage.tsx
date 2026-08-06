import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import type { UsageStatsDto } from "../types";
import {
  Checkbox,
  LoadingRows,
  PageFrame,
  PageHeader,
} from "../components/PageFrame";

type Range = "today" | "week" | "month" | "all";

const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "week", label: "近 7 天" },
  { id: "month", label: "近 30 天" },
  { id: "all", label: "全部" },
];

/** 紧凑数字：1234567 → 1.2M，12345 → 12K */
function compact(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtCost(
  c: number | null,
  currency: "$" | "¥",
  rate: number,
  partial: boolean,
): string {
  if (c == null) return "~";
  const prefix = partial ? "≥" : "";
  return currency === "¥"
    ? `${prefix}¥${(c * rate).toFixed(2)}`
    : `${prefix}$${c.toFixed(2)}`;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 官方账号（订阅制）行的费用格：不按量计费，固定显示「订阅」并注明口径 */
function SubscriptionCost() {
  return (
    <span title="官方账号登录，不按量计费；token 数仍为实际统计">订阅</span>
  );
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

/**
 * 每个 agent 的进度条色相：从现有设计令牌取色（低饱和、状态色系的浅字档）。
 * 随主题切换联动的令牌用 CSS 变量引用。
 */
const AGENT_COLORS: Record<string, string> = {
  "claude-code": "var(--color-ok-text)",
  codex: "var(--color-link)",
  gemini: "var(--color-warn-text)",
  qwen: "var(--color-err-text)",
  opencode: "var(--color-add)",
  kimi: "var(--color-tabline)",
};
/** 未知 agent 兜底：按 id 哈希取 HSL 色，确定性且不再复用上方令牌池
    （原按列表序循环同一组令牌，未知 agent 会与已知 agent 固定色撞色） */
function fallbackColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 65%)`;
}
const agentColor = (id: string) => AGENT_COLORS[id] ?? fallbackColor(id);

export default function StatsPage({ visible }: { visible: boolean }) {
  const [range, setRange] = useState<Range>("week");
  const [currency, setCurrency] = useState<"$" | "¥">(
    () => (localStorage.getItem("ccode.statsCurrency") as "$" | "¥") || "$",
  );
  const [stats, setStats] = useState<UsageStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [showInternal, setShowInternal] = useState(
    () => localStorage.getItem("ccode.stats.showInternal") === "1",
  );

  // 并发守卫：快速切换范围时旧响应不得覆盖新范围
  const loadSeq = useRef(0);

  async function load(r: Range) {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await invoke<UsageStatsDto>("get_usage_stats", { range: r });
      if (seq !== loadSeq.current) return;
      setStats(res);
      setError(null);
    } catch (e) {
      if (seq === loadSeq.current) setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (visible) void load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, range]);

  /** 重建用量索引后再拉取统计 */
  async function onRebuild() {
    setRebuilding(true);
    setNotice(null);
    try {
      const res = await invoke<{ sessionsIndexed: number; rows: number }>(
        "rebuild_usage_index",
      );
      setNotice(`已索引 ${res.sessionsIndexed} 个对话`);
      setTimeout(() => setNotice(null), 4000);
      setError(null);
      await load(range);
    } catch (e) {
      setError(String(e));
    } finally {
      setRebuilding(false);
    }
  }

  const empty =
    stats !== null &&
    stats.byAgent.length === 0 &&
    stats.byProject.length === 0 &&
    stats.byModel.length === 0 &&
    stats.cards.sessions === 0;
  const totalAgentTokens = Math.max(
    1,
    stats?.byAgent.reduce((s, a) => s + a.tokens, 0) ?? 1,
  );
  const rate = stats?.rateUsdCny ?? 7.2;
  const th = "px-2 py-1.5 text-left text-xs font-normal text-l3";

  const projectRows = useMemo(() => {
    if (!stats || showInternal) return stats?.byProject ?? [];
    const normal = stats.byProject.filter((p) => !p.internal);
    const internal = stats.byProject.filter((p) => p.internal);
    if (internal.length === 0) return normal;
    return [
      ...normal,
      {
        projectPath: "Ccode 内部 AI 任务",
        tokens: internal.reduce((n, p) => n + p.tokens, 0),
        sessions: internal.reduce((n, p) => n + p.sessions, 0),
        costUsd: internal.some((p) => p.costUsd != null)
          ? internal.reduce((n, p) => n + (p.costUsd ?? 0), 0)
          : null,
        costPartial: internal.some((p) => p.costPartial || p.costUsd == null),
        source: "ccode-ai",
        internal: true,
        official: false,
      },
    ].sort((a, b) => b.tokens - a.tokens);
  }, [showInternal, stats]);

  const modelRows = useMemo(() => {
    if (!stats || showInternal) return stats?.byModel ?? [];
    const normal = stats.byModel.filter((m) => !m.internal);
    const internal = stats.byModel.filter((m) => m.internal);
    if (internal.length === 0) return normal;
    return [
      ...normal,
      {
        model: "Ccode 内部 / 未识别模型",
        input: internal.reduce((n, m) => n + m.input, 0),
        output: internal.reduce((n, m) => n + m.output, 0),
        costUsd: internal.some((m) => m.costUsd != null)
          ? internal.reduce((n, m) => n + (m.costUsd ?? 0), 0)
          : null,
        costPartial: internal.some((m) => m.costPartial || m.costUsd == null),
        source: "ccode-ai",
        internal: true,
      },
    ].sort((a, b) => b.input + b.output - (a.input + a.output));
  }, [showInternal, stats]);

  // 任务成本：与项目排行同一开关口径——默认隐藏 internal 行，打开「显示内部活动」才展示
  const workspaceRows = useMemo(() => {
    const rows = stats?.byWorkspace ?? [];
    return showInternal ? rows : rows.filter((w) => !w.internal);
  }, [showInternal, stats]);

  function toggleCurrency() {
    const next = currency === "$" ? "¥" : "$";
    setCurrency(next);
    localStorage.setItem("ccode.statsCurrency", next);
  }

  return (
    <PageFrame width="standard">
      <PageHeader title="用量统计" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setRange(item.id)}
              className={`rounded px-2.5 py-1 text-xs ${
                range === item.id
                  ? "bg-seg-sel text-l1"
                  : "text-l3 hover:text-l1"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Checkbox
            checked={showInternal}
            onChange={(checked) => {
              setShowInternal(checked);
              localStorage.setItem(
                "ccode.stats.showInternal",
                checked ? "1" : "0",
              );
            }}
            label="显示内部活动"
            className="rounded px-2 py-0.5 text-xs text-l3 hover:bg-white/5"
          />
          <button
            type="button"
            onClick={toggleCurrency}
            title="切换货币（$ 美元 / ¥ 人民币）"
            className="w-7 rounded px-1 py-1 text-xs text-l3 hover:text-l1"
          >
            {currency}
          </button>
          <button
            type="button"
            onClick={() => void onRebuild()}
            disabled={rebuilding}
            className="rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            {rebuilding ? "索引中…" : "刷新"}
          </button>
          {/* 切换范围时保留旧数据，仅局部提示加载，骨架只用于首载 */}
          {loading && stats !== null && (
            <span className="px-1 text-xs text-l4">加载中…</span>
          )}
        </div>
      </div>
      <p className="mb-3 text-xs text-l4">
        费用按官方公开价估算；≥ 表示另含未计价用量，~ 表示没有可用价格
      </p>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      {!stats ? (
        <LoadingRows />
      ) : empty ? (
        <p className="py-8 text-sm text-l4">
          暂无用量数据——用 agent 跑几个任务后再来
        </p>
      ) : (
        <>
          {/* 概览卡片 */}
          <div className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div className="rounded bg-inset p-3">
              <div className="text-xs text-l4">输入 tokens</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {compact(stats.cards.input)}
              </div>
            </div>
            <div className="rounded bg-inset p-3">
              <div className="text-xs text-l4">输出 tokens</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {compact(stats.cards.output)}
              </div>
            </div>
            <div className="rounded bg-inset p-3">
              <div className="text-xs text-l4">缓存读 tokens</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {compact(stats.cards.cacheRead)}
              </div>
              <div className="mt-0.5 text-xs text-l4">
                缓存写 {compact(stats.cards.cacheWrite)}
              </div>
            </div>
            <div className="rounded bg-inset p-3">
              <div className="text-xs text-l4">对话数</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {compact(stats.cards.sessions)}
              </div>
            </div>
            <div className="rounded bg-inset p-3">
              <div className="text-xs text-l4">费用</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {fmtCost(
                  stats.cards.costUsd,
                  currency,
                  rate,
                  stats.cards.costPartial,
                )}
              </div>
            </div>
          </div>

          {/* 按 agent：用量占比进度条（占比 = 该 agent tokens / 全部合计） */}
          {stats.byAgent.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">按 Agent</h2>
              <ul className="divide-y divide-hairline">
                {stats.byAgent.map((a) => {
                  const share = a.tokens / totalAgentTokens;
                  return (
                    <li
                      key={`${a.agent}-${a.official}`}
                      className="flex items-center gap-3 py-2 text-sm"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: agentColor(a.agent) }}
                      />
                      <span className="w-24 shrink-0">
                        <span className="block text-l2">
                          {agentLabel(a.agent)}
                        </span>
                        <span
                          className="block text-xs text-l4"
                          title={`统计范围内使用了 ${a.modelCount} 个不同模型`}
                        >
                          {a.modelCount} 个模型
                        </span>
                      </span>
                      <span className="h-2 min-w-0 flex-1 rounded bg-hairline">
                        <span
                          className="block h-2 rounded"
                          style={{
                            width: `${Math.max(1.5, share * 100)}%`,
                            backgroundColor: agentColor(a.agent),
                          }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-xs text-l2">
                        {compact(a.tokens)}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-xs text-l3">
                        {(share * 100).toFixed(1)}%
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs text-l3">
                        {a.official ? (
                          <SubscriptionCost />
                        ) : (
                          fmtCost(a.costUsd, currency, rate, a.costPartial)
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* 按项目 */}
          {projectRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">
                按项目（前 20）
              </h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>项目</th>
                    <th className={`${th} text-right`}>对话数</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {projectRows.slice(0, 20).map((p) => (
                    <tr
                      key={`${p.internal}-${p.official}-${p.source}-${p.projectPath}`}
                      className="border-b border-hairline"
                    >
                      <td
                        className="max-w-0 truncate px-2 py-2 text-l2"
                        title={p.projectPath}
                      >
                        {basename(p.projectPath)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {p.sessions}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l2">
                        {compact(p.tokens)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {p.official ? (
                          <SubscriptionCost />
                        ) : (
                          fmtCost(p.costUsd, currency, rate, p.costPartial)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 任务成本（按工作区归因，仅列出命中工作区的用量） */}
          {workspaceRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">任务成本</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>任务</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {workspaceRows.map((w) => (
                    <tr
                      key={`${w.internal}-${w.official}-${w.repoName}-${w.workspaceName}`}
                      className="border-b border-hairline"
                    >
                      <td className="max-w-0 truncate px-2 py-2 text-l2">
                        <span className="font-mono">{w.workspaceName}</span>
                        <span className="ml-2 text-xs text-l4">
                          {w.repoName}
                        </span>
                      </td>
                      <td
                        className="px-2 py-2 text-right font-mono text-xs text-l2"
                        title={`输入 ${compact(w.tokensIn)} / 输出 ${compact(
                          w.tokensOut,
                        )}，${w.models} 个模型`}
                      >
                        {compact(w.tokensIn + w.tokensOut)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {w.official ? (
                          <SubscriptionCost />
                        ) : (
                          fmtCost(w.cost, currency, rate, w.costPartial)
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 按模型 */}
          {modelRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">按模型</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>模型</th>
                    <th className={`${th} text-right`}>输入</th>
                    <th className={`${th} text-right`}>输出</th>
                    <th className={`${th} text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {modelRows.map((m) => (
                    <tr
                      key={`${m.internal}-${m.source}-${m.model}`}
                      className="border-b border-hairline"
                    >
                      <td
                        className="max-w-0 truncate px-2 py-2 text-l2"
                        title={m.model}
                      >
                        {m.model || "（未知）"}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l3">
                        {compact(m.input)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l3">
                        {compact(m.output)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {fmtCost(m.costUsd, currency, rate, m.costPartial)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </PageFrame>
  );
}
