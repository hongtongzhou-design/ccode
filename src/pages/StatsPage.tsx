import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "../types";
import type { UsageStatsDto } from "../types";

type Range = "today" | "week" | "month" | "all";

const RANGES: { id: Range; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "week", label: "近 7 天" },
  { id: "month", label: "近 30 天" },
  { id: "all", label: "全部" },
];

/** 紧凑数字：1234567 → 1.2M，12345 → 12K */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtCost(c: number | null): string {
  return c == null ? "~" : `$${c.toFixed(2)}`;
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

export default function StatsPage({ visible }: { visible: boolean }) {
  const [range, setRange] = useState<Range>("week");
  const [stats, setStats] = useState<UsageStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  async function load(r: Range) {
    setLoading(true);
    try {
      setStats(await invoke<UsageStatsDto>("get_usage_stats", { range: r }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
      setNotice(`已索引 ${res.sessionsIndexed} 个会话`);
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
  const maxAgentTokens = Math.max(1, ...(stats?.byAgent.map((a) => a.tokens) ?? [1]));
  const th = "px-2 py-1.5 text-left text-xs font-normal text-l4";

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-l1">用量统计</h1>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={`rounded px-2.5 py-1 text-xs ${
                  range === r.id ? "bg-seg-sel text-l1" : "text-l3 hover:text-l1"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={onRebuild}
            disabled={rebuilding}
            className="rounded px-2 py-1 text-sm text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            {rebuilding ? "索引中…" : "刷新"}
          </button>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      {!stats || loading ? (
        <p className="py-8 text-sm text-l4">{loading ? "加载中…" : ""}</p>
      ) : empty ? (
        <p className="py-8 text-sm text-l4">
          暂无用量数据——用 agent 跑几个任务后再来
        </p>
      ) : (
        <>
          {/* 概览卡片 */}
          <div className="mb-6 grid grid-cols-4 gap-3">
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
              <div className="text-xs text-l4">会话数</div>
              <div className="mt-1 text-lg font-semibold text-l1">
                {compact(stats.cards.sessions)}
              </div>
              <div className="mt-0.5 text-xs text-l4">
                估算费用 {fmtCost(stats.cards.costUsd)}
              </div>
            </div>
          </div>

          {/* 按 agent：横向条形 */}
          {stats.byAgent.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">按 Agent</h2>
              <ul className="divide-y divide-hairline">
                {stats.byAgent.map((a) => (
                  <li key={a.agent} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-24 shrink-0 text-l2">{agentLabel(a.agent)}</span>
                    <span className="h-2 min-w-0 flex-1 rounded bg-hairline">
                      <span
                        className="block h-2 rounded bg-field"
                        style={{ width: `${Math.max(2, (a.tokens / maxAgentTokens) * 100)}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-xs text-l2">
                      {compact(a.tokens)}
                    </span>
                    <span className="w-14 shrink-0 text-right text-xs text-l3">
                      {fmtCost(a.costUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 按项目 */}
          {stats.byProject.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-l1">按项目（前 20）</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline">
                    <th className={th}>项目</th>
                    <th className={`${th} text-right`}>会话数</th>
                    <th className={`${th} text-right`}>tokens</th>
                    <th className={`${th} text-right`}>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byProject.slice(0, 20).map((p) => (
                    <tr key={p.projectPath} className="border-b border-hairline">
                      <td className="max-w-0 truncate px-2 py-2 text-l2" title={p.projectPath}>
                        {basename(p.projectPath)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">{p.sessions}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l2">
                        {compact(p.tokens)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {fmtCost(p.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* 按模型 */}
          {stats.byModel.length > 0 && (
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
                  {stats.byModel.map((m) => (
                    <tr key={m.model} className="border-b border-hairline">
                      <td className="max-w-0 truncate px-2 py-2 text-l2" title={m.model}>
                        {m.model || "（未知）"}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l3">
                        {compact(m.input)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-l3">
                        {compact(m.output)}
                      </td>
                      <td className="px-2 py-2 text-right text-xs text-l3">
                        {fmtCost(m.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
