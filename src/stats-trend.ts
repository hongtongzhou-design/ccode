/** 统计页「每日用量」折线的纯逻辑：自适应日期轴（折线路径本身很简单，留在组件里）。
 *  手绘 SVG（不引图表库），交互态（悬停点/tooltip）留在 StatsPage 组件里。 */

/** 两个 YYYY-MM-DD 之间相隔的天数（按 UTC 日界算，避开时区/夏令时误差） */
export function spanDays(first: string, last: string): number {
  const a = Date.parse(`${first}T00:00:00Z`);
  const b = Date.parse(`${last}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export interface AxisLabel {
  /** 对应数据点下标（渲染在该点正下方） */
  index: number;
  label: string;
}

/** 自适应日期轴标签：跨度 ≤45 天按「MM-DD」均匀抽稀；更久改按月首标注
 *  「M月」（跨年带年份「YY年M月」）。标签数不超过 maxLabels。 */
export function axisLabels(days: string[], maxLabels = 7): AxisLabel[] {
  const n = days.length;
  if (n === 0) return [];
  if (spanDays(days[0], days[n - 1]) <= 45) {
    const step = Math.max(1, Math.ceil(n / maxLabels));
    const out: AxisLabel[] = [];
    for (let i = 0; i < n; i += step)
      out.push({ index: i, label: days[i].slice(5) });
    if (out[out.length - 1]?.index !== n - 1)
      out.push({ index: n - 1, label: days[n - 1].slice(5) });
    return out;
  }
  // 按月：标每个月出现的第一个点
  const monthFirst: { index: number; ym: string }[] = [];
  let prev = "";
  days.forEach((day, i) => {
    const ym = day.slice(0, 7);
    if (ym !== prev) {
      monthFirst.push({ index: i, ym });
      prev = ym;
    }
  });
  const step = Math.max(1, Math.ceil(monthFirst.length / maxLabels));
  const singleYear =
    days[0].slice(0, 4) === days[n - 1].slice(0, 4);
  return monthFirst
    .filter((_, i) => i % step === 0)
    .map(({ index, ym }) => {
      const [y, m] = ym.split("-");
      return {
        index,
        label: singleYear ? `${Number(m)}月` : `${y.slice(2)}年${Number(m)}月`,
      };
    });
}
