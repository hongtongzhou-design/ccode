import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import { useAppStore } from "../store";
import type { UsageDayDto, UsageStatsDto } from "../types";
import { axisLabels } from "../stats-trend";
import { agentBrand } from "../agent-colors";
import {
  Checkbox,
  EmptyState,
  LoadingRows,
  PageFrame,
  PageHeader,
  PageToolbar,
  rowActionClass,
  SegTabs,
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

/**
 * 每日用量折线（手绘 SVG，不引图表库）：
 * - 直折线段 + 渐变面积（用户拍板：不要平滑曲线，保留折线形式；v3.94 面积改垂直渐变）
 * - 底部日期轴常驻（v3.94 起：原「悬停才显」被用户否为不悬浮时无法定位时间节点）；
 *   跨度 ≤45 天按「MM-DD」标注，更久自动降为按月（跨年带年份）
 * - 悬停时显示竖向指示线 + 命中点 + 当日明细（合计 tokens / 费用）
 */
function DailyTrend({
  pts,
  currency,
  rate,
}: {
  pts: UsageDayDto[];
  currency: "$" | "¥";
  rate: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...pts.map((d) => d.input + d.output));
  const W = 720;
  const H = 96;
  // 上下留白，峰值点与零值点不贴边
  const PAD = 6;
  const stepX = W / Math.max(1, pts.length - 1);
  const coords = pts.map((d, i) => {
    const v = d.input + d.output;
    return [i * stepX, H - PAD - (v / peak) * (H - PAD * 2)] as const;
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
    <div className="rounded-lg bg-strip p-3">
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
          aria-label={`每日 token 折线，峰值 ${peak.toLocaleString()}`}
        >
          {/* 面积填充走垂直渐变（折线处 15% → X 轴处 0%，Stripe/Vercel 式），
              stop 引用 cta 令牌、随主题换色 */}
          <defs>
            <linearGradient id="dailyTrendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--color-cta)" stopOpacity="0.15" />
              <stop offset="1" stopColor="var(--color-cta)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#dailyTrendFill)" />
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
            {/* 指示线与命中点走 HTML 覆盖层：preserveAspectRatio="none" 会把 SVG 圆拉成椭圆 */}
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
              // 边缘钳制，tooltip 不出图区
              style={{
                left: `${Math.min(85, Math.max(15, hx))}%`,
                transform: "translateX(-50%)",
              }}
            >
              {hd.day} · 合计 {compact(hd.input + hd.output)} tokens（入{" "}
              {compact(hd.input)} / 出 {compact(hd.output)}） ·{" "}
              {fmtCost(hd.costUsd, currency, rate, hd.costPartial)}
            </div>
          </>
        )}
      </div>
      {/* 日期轴常驻；nowrap：「08-15」的连字符是 CSS 断行机会，右端标签会在那里换行被截断 */}
      <div className="relative mt-1 h-4 text-micro text-l4">
        {labels.map((l) => (
          <span
            key={l.index}
            // nowrap：「08-15」的连字符是 CSS 断行机会，右端标签会在那里换行被截断
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
      <div className="mt-1 flex justify-between text-micro text-l4">
        <span>峰值 {peak.toLocaleString()} tokens/天</span>
        <span>{pts.length} 天有用量</span>
      </div>
    </div>
  );
}

export default function StatsPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
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

  function toggleCurrency() {
    const next = currency === "$" ? "¥" : "$";
    setCurrency(next);
    localStorage.setItem("ccode.statsCurrency", next);
  }

  return (
    <PageFrame width="fluid">
      <PageHeader
        title="用量"
        meta="按项目、任务与 Agent 查看投入"
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
      <p className="mb-3 text-xs text-l4">
        费用按官方公开价估算；≥ 表示另含未计价用量，~ 表示没有可用价格
      </p>
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
          {/* 概览 KPI 卡（v3.94，用户拍板卡片化取代纯文本平铺）：strip 底 + l1 12% 极浅勾边
              （启动栏卡片同款精致边线，field 档浅色偏蓝、hairline 档糊进点阵）；
              标签 text-xs font-medium + 最淡 l4，与 24px semibold 数字拉开层级；
              费用卡的高亮两次迭代（cta-pill 蓝底、warn 琥珀底均被否为难看）后定为：
              去底色、边框略粗一档（1px + l1 25% 勾边，介于全站 0.5px 与 2px 之间）——
              走内联 style 不带 border 类，否则 App.css 全站 0.5px 覆写会把它压回去；
              数字一律 tabular-nums */}
          {(() => {
            const cardCls =
              "rounded-lg border bg-strip p-4 text-xs font-medium tracking-wider text-l4";
            const numCls =
              "mt-1 text-2xl font-semibold tracking-tight tabular-nums text-l1";
            const cardEdge = {
              borderColor: "color-mix(in srgb, var(--color-l1) 12%, transparent)",
            };
            return (
              <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-7">
                <div className={`${cardCls} sm:col-span-2`} style={cardEdge}>
                  总 tokens
                  <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-l1">
                    {compact(totalTokens)}
                  </div>
                  <div className="mt-0.5 text-micro font-normal tracking-normal text-l4">
                    输入 {compact(stats.cards.input)} · 输出 {compact(stats.cards.output)}
                  </div>
                </div>
                <div className={cardCls} style={cardEdge}>
                  输入 tokens
                  <div className={numCls}>{compact(stats.cards.input)}</div>
                </div>
                <div className={cardCls} style={cardEdge}>
                  输出 tokens
                  <div className={numCls}>{compact(stats.cards.output)}</div>
                </div>
                <div className={cardCls} style={cardEdge}>
                  缓存读 tokens
                  <div className={numCls}>{compact(stats.cards.cacheRead)}</div>
                  <div className="mt-0.5 text-micro text-l4">
                    缓存写 {compact(stats.cards.cacheWrite)}
                  </div>
                </div>
                <div className={cardCls} style={cardEdge}>
                  对话数
                  <div className={numCls}>{compact(stats.cards.sessions)}</div>
                </div>
                <div
                  className="rounded-lg bg-strip p-4 text-xs font-medium tracking-wider text-l4"
                  style={{
                    border:
                      "1px solid color-mix(in srgb, var(--color-l1) 25%, transparent)",
                  }}
                >
                  费用
                  <div className={numCls}>
                    {fmtCost(
                      stats.cards.costUsd,
                      currency,
                      rate,
                      stats.cards.costPartial,
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 趋势（v3.88）：区间总数看不出「这周比上周多花多少」——这是统计页最核心的缺口。
              手绘 SVG 平滑折线，不引图表库（package.json 保持零图表依赖）；纯逻辑（平滑路径/
              自适应日期轴）在 stats-trend.ts。日期轴常驻（v3.94 起，原悬停才显被否为定位不便），
              数值 tooltip 仍悬停才淡入。 */}
          {stats.daily.length > 1 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-l3">
                每日用量
                <span className="ml-2 font-normal text-l4">
                  {stats.daily[0].day} → {stats.daily[stats.daily.length - 1].day}
                </span>
              </h2>
              <DailyTrend pts={stats.daily} currency={currency} rate={rate} />
            </section>
          )}

          {/* 按 agent：用量占比进度条（占比 = 该 agent tokens / 全部合计） */}
          {stats.byAgent.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-l3">按 Agent</h2>
              <ul className="space-y-1">
                {stats.byAgent.map((a) => {
                  const share = a.tokens / totalAgentTokens;
                  return (
                    <li
                      key={`${a.agent}-${a.official}`}
                      className="flex items-center gap-3 rounded-md bg-strip px-2 py-2 text-sm"
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
            </section>
          )}

          {/* 按项目 */}
          {projectRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-l3">
                按项目（前 20）
              </h2>
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
            </section>
          )}

          {/* 任务成本（按工作区归因，仅列出命中工作区的用量） */}
          {workspaceRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-l3">任务成本</h2>
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
            </section>
          )}

          {/* 按模型 */}
          {modelRows.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium text-l3">按模型</h2>
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
            </section>
          )}
        </>
      )}
    </PageFrame>
  );
}
