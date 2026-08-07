/** 相对时间（白话主显）：「刚刚 / N 分钟前 / N 小时前 / N 天前」，超过 30 天回落日期；
 *  悬浮 title 用 absTime 给绝对时间（白话双层：相对为主、绝对降为悬浮） */
export function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 绝对时间（悬浮二级呈现）：无法解析时返回空串 */
export function absTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}
