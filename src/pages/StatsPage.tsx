import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import type {
  GatewayUsageRow,
  UsageStatsDto,
  UsageTopSessionDto,
  UsageTrendDto,
} from "../types";
import { axisLabels } from "../stats-trend";
import {
  cacheHitRate,
  sessionDisplayTitle,
  weekOverWeek,
} from "../stats-insight";
import { agentBrand } from "../agent-colors";
import {
  Checkbox,
  EmptyState,
  FoldMark,
  LoadingRows,
  PageFrame,
  PageHeader,
  PageToolbar,
  rowActionClass,
  SegTabs,
} from "../components/PageFrame";
import type { WeekOverWeek } from "../stats-insight";

type Range = "today" | "week" | "month" | "all";
type DistView = "sessions" | "agent" | "project" | "gateway" | "task";
type ChartMetric = "cost" | "tokens";

const DIST: { id: DistView; label: string }[] = [
  { id: "sessions", label: "最贵" },
  { id: "agent", label: "Agent" },
  { id: "project", label: "项目" },
  { id: "gateway", label: "网关" },
  { id: "task", label: "任务" },
];

const CHART_METRICS: { id: ChartMetric; label: string }[] = [
  { id: "cost", label: "花费" },
  { id: "tokens", label: "用量" },
];

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

/** 明细表费用列保持单行；金额过长时省略，完整值仍可通过悬浮查看。 */
function CostText({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block max-w-full truncate whitespace-nowrap" title={typeof children === "string" ? children : undefined}>
      {children}
    </span>
  );
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

/** agent 进度条色相：v3.94 起走品牌色 AGENT_BRAND（与对话页胶囊同一出处，
    共享自 src/agent-colors.ts；原令牌色 AGENT_COLORS 仅剩其它用途时保留） */

function wowLabel(
  wow: WeekOverWeek | null,
  currency: "$" | "¥",
  rate: number,
): { text: string; tone: "up" | "down" | "flat" } | null {
  if (!wow) return null;
  const amount = fmtCost(wow.thisWeek, currency, rate, false);
  if (wow.percent == null) return { text: `本周 ${amount}`, tone: "flat" };
  if (wow.percent === 0)
    return { text: `本周 ${amount} · 与上周持平`, tone: "flat" };
  const arrow = wow.percent > 0 ? "▲" : "▼";
  return {
    text: `本周 ${amount} · 较上周 ${arrow}${Math.abs(wow.percent)}%`,
    tone: wow.percent > 0 ? "up" : "down",
  };
}

type ChartPt = { day: string; value: number; tip: string };

/** 花费/用量共用折线（手绘 SVG）。日期轴常驻，悬停才出当日数字。 */
function UsageChart({ pts, aria }: { pts: ChartPt[]; aria: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(0.01, ...pts.map((d) => d.value));
  const W = 720;
  const H = 96;
  const PAD = 6;
  const stepX = W / Math.max(1, pts.length - 1);
  const coords = pts.map((d, i) => {
    return [i * stepX, H - PAD - (d.value / peak) * (H - PAD * 2)] as const;
  });
  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const labels = axisLabels(pts.map((d) => d.day));
  const last = Math.max(1, pts.length - 1);

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * last));
  }

  const hd = hover !== null ? pts[hover] : null;
  const hx = hover !== null ? (coords[hover][0] / W) * 100 : 0;
  const hy = hover !== null ? (coords[hover][1] / H) * 100 : 0;

  return (
    <div>
      <div
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-24 w-full"
          role="img"
          aria-label={aria}
        >
          <defs>
            <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--color-cta)" stopOpacity="0.15" />
              <stop offset="1" stopColor="var(--color-cta)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#usageChartFill)" />
          <path
            d={line}
            className="stroke-cta"
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hd && (
          <>
            <div
              className="pointer-events-none absolute bottom-0 top-0 w-px bg-cta/40"
              style={{ left: `${hx}%` }}
            />
            <div
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cta ring-2 ring-strip"
              style={{ left: `${hx}%`, top: `${hy}%` }}
            />
            <div
              className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-field px-2 py-1 text-micro text-l2 ccode-float-surface"
              style={{
                left: `${Math.min(85, Math.max(15, hx))}%`,
                transform: "translateX(-50%)",
              }}
            >
              {hd.day} · {hd.tip}
            </div>
          </>
        )}
      </div>
      <div className="relative mt-1 h-4 text-micro text-l4">
        {labels.map((l) => (
          <span
            key={l.index}
            className="absolute whitespace-nowrap"
            style={{
              left: `${(l.index / last) * 100}%`,
              transform:
                l.index === 0
                  ? "none"
                  : l.index === last
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function StatsPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const sessions = useAppStore((s) => s.sessions);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const [range, setRange] = useState<Range>("week");
  const [view, setView] = useState<DistView>(() =>
    sessionStorage.getItem("ccode.statsGateway") ? "gateway" : "sessions",
  );
  const [chartMetric, setChartMetric] = useState<ChartMetric>(
    () =>
      (localStorage.getItem("ccode.stats.chartMetric") as ChartMetric) || "cost",
  );
  const [modelsOpen, setModelsOpen] = useState(
    () => localStorage.getItem("ccode.stats.modelsOpen") === "1",
  );
  const [gatewayRows, setGatewayRows] = useState<GatewayUsageRow[]>([]);
  const [focusGateway, setFocusGateway] = useState<string | null>(() => {
    const v = sessionStorage.getItem("ccode.statsGateway");
    if (v) sessionStorage.removeItem("ccode.statsGateway");
    return v;
  });
  const [currency, setCurrency] = useState<"$" | "¥">(
    () => (localStorage.getItem("ccode.statsCurrency") as "$" | "¥") || "$",
  );
  const [stats, setStats] = useState<UsageStatsDto | null>(null);
  const [trend, setTrend] = useState<UsageTrendDto | null>(null);
  const [topSessions, setTopSessions] = useState<UsageTopSessionDto[]>([]);
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
      const [res, gw, tr, top] = await Promise.all([
        invoke<UsageStatsDto>("get_usage_stats", { range: r }),
        invoke<GatewayUsageRow[]>("usage_by_gateway", { range: r }).catch(
          () => [] as GatewayUsageRow[],
        ),
        invoke<UsageTrendDto>("usage_trend", { range: r }).catch(() => null),
        invoke<UsageTopSessionDto[]>("top_sessions", { range: r }).catch(
          () => [] as UsageTopSessionDto[],
        ),
      ]);
      if (seq !== loadSeq.current) return;
      setStats(res);
      setGatewayRows(gw);
      setTrend(tr);
      setTopSessions(top);
      setError(null);
    } catch (e) {
      if (seq === loadSeq.current) setError(String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (visible) {
      void load(range);
      void loadSessions();
    }
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
  const totalTokens = (stats?.cards.input ?? 0) + (stats?.cards.output ?? 0);
  // 分布区表头：caps 式小字加字距（同 SkillsPage 表头规格），弱化只作列定位
  const th = "px-2 py-1.5 text-left text-micro font-normal tracking-wider text-l4";

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

  const hit = stats
    ? cacheHitRate(stats.cards.input, stats.cards.cacheRead)
    : null;
  const trendLive = Boolean(trend?.days.some((d) => d.hasUsage));
  const wow =
    trendLive && trend && trend.days.length > 0
      ? weekOverWeek(
          trend.days.map((d) => ({
            day: d.day,
            costUsd: d.costUsd,
            hasUsage: d.hasUsage,
          })),
          trend.days[trend.days.length - 1].day,
        )
      : null;
  const badge = wowLabel(wow, currency, rate);
  const inShare =
    totalTokens > 0 && stats
      ? Math.round((stats.cards.input / totalTokens) * 100)
      : 0;
  const perChat =
    stats && stats.cards.sessions > 0 && stats.cards.costUsd != null
      ? stats.cards.costUsd / stats.cards.sessions
      : null;
  const distItems = DIST.filter((item) => {
    if (item.id === "sessions") return topSessions.length > 0;
    if (item.id === "agent") return (stats?.byAgent.length ?? 0) > 0;
    if (item.id === "project") return projectRows.length > 0;
    if (item.id === "gateway") return gatewayRows.length > 0;
    return workspaceRows.length > 0;
  });
  const dist: DistView = distItems.some((item) => item.id === view)
    ? view
    : (distItems[0]?.id ?? "agent");
  const rangeLabel = RANGES.find((item) => item.id === range)?.label ?? "";
  const costPts: ChartPt[] = (trend?.days ?? []).map((d) => ({
    day: d.day,
    value: d.costUsd ?? 0,
    tip: fmtCost(d.costUsd, currency, rate, d.costPartial),
  }));
  const tokenPts: ChartPt[] = (stats?.daily ?? []).map((d) => ({
    day: d.day,
    value: d.input + d.output,
    tip: `${compact(d.input + d.output)} tokens · ${fmtCost(d.costUsd, currency, rate, d.costPartial)}`,
  }));
  const canCost = trendLive && costPts.length > 1;
  const canTokens = tokenPts.length > 1;
  const metric: ChartMetric =
    chartMetric === "cost" && canCost ? "cost" : canTokens ? "tokens" : "cost";
  const chartPts = metric === "cost" ? costPts : tokenPts;

  function toggleCurrency() {
    const next = currency === "$" ? "¥" : "$";
    setCurrency(next);
    localStorage.setItem("ccode.statsCurrency", next);
  }

  return (
    <PageFrame width="fluid">
      <PageHeader
        title="用量"
        meta="只计经 Ccode 记下归属的会话。费用按公开价估算，≥ 含未计价，~ 无价格。"
      />
      <PageToolbar>
        <SegTabs items={RANGES} value={range} onChange={setRange} />
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
            className="rounded-sm px-2 py-0.5 text-xs text-l3 hover:bg-hover"
          />
          <button
            type="button"
            onClick={toggleCurrency}
            title="切换货币（$ 美元 / ¥ 人民币）"
            className="w-7 rounded-sm px-1 py-1 text-xs text-l3 hover:text-l1"
          >
            {currency}
          </button>
          <button
            type="button"
            onClick={() => void onRebuild()}
            disabled={rebuilding}
            className={rowActionClass}
          >
            {rebuilding ? "索引中…" : "刷新"}
          </button>
          {/* 切换范围时保留旧数据，仅局部提示加载，骨架只用于首载 */}
          {loading && stats !== null && (
            <span className="px-1 text-xs text-l4">加载中…</span>
          )}
        </div>
      </PageToolbar>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      {!stats ? (
        <LoadingRows />
      ) : empty ? (
        <EmptyState
          title="还没有用量记录"
          detail="跑几个 agent 会话后，这里会按天汇总 token 和费用。"
        />
      ) : (
        <>
          <div className="mb-6 rounded-lg bg-strip p-4">
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
              <div>
                <div className="text-xs font-medium tracking-wider text-l4">
                  费用
                </div>
                <div className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums text-l1">
                  {fmtCost(
                    stats.cards.costUsd,
                    currency,
                    rate,
                    stats.cards.costPartial,
                  )}
                </div>
                {badge && (
                  <div
                    className={`mt-1 text-xs tabular-nums ${
                      badge.tone === "up"
                        ? "text-warn-text"
                        : badge.tone === "down"
                          ? "text-ok-text"
                          : "text-l3"
                    }`}
                  >
                    {badge.text}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-medium tracking-wider text-l4">
                  tokens
                </div>
                <div className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums text-l1">
                  {compact(totalTokens)}
                </div>
                <div className="mt-1 text-micro text-l4">
                  输入 {inShare}% · 输出 {100 - inShare}%
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-l3">
              {stats.cards.sessions} 次对话
              {perChat != null && (
                <>
                  {" "}
                  · 场均 {fmtCost(perChat, currency, rate, stats.cards.costPartial)}
                </>
              )}
              {hit != null && (
                <>
                  {" "}
                  · 缓存 {(hit * 100).toFixed(0)}%
                  {stats.cards.cacheSavingsUsd != null &&
                    stats.cards.costUsd != null && (
                      <>
                        {" "}
                        · 若无缓存约{" "}
                        {fmtCost(
                          stats.cards.costUsd + stats.cards.cacheSavingsUsd,
                          currency,
                          rate,
                          stats.cards.costPartial,
                        )}
                      </>
                    )}
                </>
              )}
            </p>
            {chartPts.length > 1 && (
              <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  {canCost && canTokens ? (
                    <SegTabs
                      items={CHART_METRICS}
                      value={metric}
                      onChange={(id) => {
                        setChartMetric(id);
                        localStorage.setItem("ccode.stats.chartMetric", id);
                      }}
                    />
                  ) : (
                    <span className="text-xs text-l3">
                      {metric === "cost"
                        ? `${rangeLabel}花费`
                        : `${rangeLabel}用量`}
                    </span>
                  )}
                  {canCost && canTokens && (
                    <span className="text-micro text-l4">{rangeLabel}</span>
                  )}
                </div>
                <UsageChart
                  pts={chartPts}
                  aria={
                    metric === "cost"
                      ? `${rangeLabel}花费折线`
                      : `${rangeLabel}用量折线`
                  }
                />
              </div>
            )}
          </div>

          {distItems.length > 0 && (
          <div className="mb-6 rounded-lg bg-strip p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <SegTabs items={distItems} value={dist} onChange={setView} />
              {dist === "gateway" && focusGateway && (
                <button
                  type="button"
                  className={rowActionClass}
                  onClick={() => setFocusGateway(null)}
                >
                  查看全部
                </button>
              )}
            </div>
          {dist === "sessions" && (
            <ul className="space-y-0.5">
              {topSessions.map((s) => {
                const scanned = sessions.find(
                  (x) => x.agent === s.agent && x.sessionId === s.sessionId,
                );
                const title = sessionDisplayTitle({
                  customTitle: s.title,
                  scannedTitle: scanned?.customTitle ?? scanned?.title,
                  sessionId: s.sessionId,
                });
                return (
                  <li key={`${s.agent}-${s.sessionId}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenSessionReq({
                          agent: s.agent,
                          sessionId: s.sessionId,
                        });
                        setPage("sessions");
                      }}
                      className="flex w-full items-baseline gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-l2">
                        {title}
                      </span>
                      <span className="max-w-[7rem] shrink-0 truncate text-micro text-l4">
                        {basename(s.projectPath)}
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-l2">
                        {fmtCost(s.costUsd, currency, rate, s.costPartial)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {dist === "gateway" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>网关</th>
                    <th className={`${th} text-right`}>会话</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {gatewayRows.map((g) => {
                    const tokens = g.tokensIn + g.tokensOut;
                    const focused = focusGateway && g.gatewayId === focusGateway;
                    const official = g.bucket === "official";
                    return (
                      <tr
                        key={`${g.bucket}-${g.gatewayId}`}
                        className={`border-b border-hairline ${focused ? "bg-hover/60" : ""}`}
                      >
                        <td className="max-w-0 truncate px-2 py-2 text-l2" title={g.gatewayName}>
                          {g.gatewayName}
                          <span className="ml-1 text-micro text-l4">{g.agents.join("、")}</span>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                          {g.sessionCount}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2">
                          {compact(tokens)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                          {official ? (
                            <SubscriptionCost />
                          ) : (
                            fmtCost(g.costUsd, currency, rate, g.costPartial)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          )}

          {dist === "agent" && (
              <ul className="space-y-1">
                {stats.byAgent.map((a) => {
                  const share = a.tokens / totalAgentTokens;
                  return (
                    <li
                      key={`${a.agent}-${a.official}`}
                      className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-hover"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: agentBrand(a.agent) }}
                      />
                      <span className="w-24 shrink-0">
                        <span className="block text-l2">
                          {agentLabel(a.agent)}
                        </span>
                        <span
                          className="block text-micro text-l4"
                          title={`统计范围内使用了 ${a.modelCount} 个不同模型`}
                        >
                          {a.modelCount} 个模型
                        </span>
                      </span>
                      {/* 轨道：inset 底（浅色≈近白浅槽/深色=微亮槽）全圆角；
                          前景与圆点同绑品牌色（v3.94 起，与对话页胶囊同 AGENT_BRAND 口径） */}
                      <span className="h-2 min-w-0 flex-1 rounded-full bg-inset">
                        <span
                          className="block h-2 rounded-full"
                          style={{
                            width: `${Math.max(1.5, share * 100)}%`,
                            backgroundColor: agentBrand(a.agent),
                          }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-l2">
                        {compact(a.tokens)}
                      </span>
                      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-l4">
                        {(share * 100).toFixed(1)}%
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-l3">
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
          )}

          {dist === "project" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>项目</th>
                    <th className={`${th} text-right`}>对话数</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {projectRows.slice(0, 20).map((p) => {
                    const canJumpToProject = Boolean(p.projectPath) && !p.internal;
                    return (
                      <tr
                        key={`${p.internal}-${p.official}-${p.source}-${p.projectPath}`}
                        className="border-b border-hairline"
                      >
                      <td className="max-w-0 truncate px-2 py-2 text-l2" title={p.projectPath}>
                        {canJumpToProject ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectProjectReq(p.projectPath);
                              setPage("workspaces");
                            }}
                            className="inline-flex max-w-full items-center truncate text-left hover:text-l1"
                            title="跳转到项目页"
                          >
                            {basename(p.projectPath)}
                            <span aria-hidden="true" className="ml-1 text-micro text-l4">
                              ↗
                            </span>
                          </button>
                        ) : (
                          <span className="truncate">{basename(p.projectPath)}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {p.sessions}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2">
                        {compact(p.tokens)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {p.official ? (
                          <CostText><SubscriptionCost /></CostText>
                        ) : (
                          <CostText>{fmtCost(p.costUsd, currency, rate, p.costPartial)}</CostText>
                        )}
                      </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          )}

          {dist === "task" && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>任务</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
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
                        className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l2"
                        title={`输入 ${compact(w.tokensIn)} / 输出 ${compact(
                          w.tokensOut,
                        )}，${w.models} 个模型`}
                      >
                        {compact(w.tokensIn + w.tokensOut)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {w.official ? (
                          <CostText><SubscriptionCost /></CostText>
                        ) : (
                          <CostText>{fmtCost(w.cost, currency, rate, w.costPartial)}</CostText>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          )}
          </div>
          )}

          {modelRows.length > 0 && (
            <section className="mb-2">
              <button
                type="button"
                onClick={() => {
                  const next = !modelsOpen;
                  setModelsOpen(next);
                  localStorage.setItem(
                    "ccode.stats.modelsOpen",
                    next ? "1" : "0",
                  );
                }}
                aria-expanded={modelsOpen}
                className="flex h-9 w-full items-center gap-2 rounded-md px-1 text-left text-sm font-medium text-l1 hover:bg-hover"
              >
                <FoldMark open={modelsOpen} boxed />
                按模型
                <span className="text-micro font-normal text-l4">
                  {modelRows.length}
                </span>
              </button>
              {modelsOpen && (
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>模型</th>
                    <th className={`${th} text-right`}>输入</th>
                    <th className={`${th} text-right`}>输出</th>
                    <th className={`${th} w-24 text-right`}>费用</th>
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
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {compact(m.input)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        {compact(m.output)}
                      </td>
                      <td className="w-24 max-w-24 overflow-hidden px-2 py-2 text-right font-mono text-xs tabular-nums text-l3">
                        <CostText>{fmtCost(m.costUsd, currency, rate, m.costPartial)}</CostText>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </section>
          )}
        </>
      )}
    </PageFrame>
  );
}
