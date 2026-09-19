// 订阅余量卡纯逻辑（用量页）：供应商显示名、卡片切换标签、窗口名、倒计时、进度分档、重置卡文案。
// 时间一律显式传 now（毫秒 epoch），禁墙钟断言（CI 纪律）。

export const PROVIDER_LABELS: Record<string, string> = {
  zhipu: "智谱",
  kimi: "Kimi",
  minimax: "MiniMax",
};

export function planProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 套餐等级精简：剥掉 GLM / GLM Coding 前缀与 Plan 后缀（GLM Coding Max → Max；MaxPlan → Max） */
export function planLevelLabel(level: string | null): string | null {
  if (!level) return null;
  const s = level
    .trim()
    .replace(/^glm\s+coding\s+/i, "")
    .replace(/^glm\s+/i, "")
    .replace(/\s*plan$/i, "")
    .trim();
  return s || null;
}

const PROVIDER_NAME_KEYWORDS: Record<string, string[]> = {
  zhipu: ["glm", "zhipu", "bigmodel", "智谱"],
  kimi: ["kimi", "moonshot"],
  minimax: ["minimax"],
};

/** 网关名是否还值得显示：只剩供应商同义词（可带数字编号，如 "GLM"、"glm 2"）时与供应商
 *  徽章重复，不再显示；有实际区分信息（"智谱备用"、"公司号"）才显示 */
export function planGatewayNameVisible(
  name: string | null | undefined,
  provider: string,
): boolean {
  if (!name) return false;
  const compact = name.toLowerCase().replace(/[\s\-_·]/g, "");
  if (!compact) return false;
  let rest = compact;
  for (const k of PROVIDER_NAME_KEYWORDS[provider] ?? []) {
    rest = rest.split(k).join("");
  }
  return rest.replace(/[0-9]+/g, "").length > 0;
}

/** 卡片切换标签：供应商名；同供应商多网关时追加网关名区分 */
export function planTabLabel(
  row: { provider: string; gatewayName: string },
  sameProviderCount: number,
): string {
  const label = planProviderLabel(row.provider);
  return sameProviderCount > 1 ? `${label} · ${row.gatewayName}` : label;
}

export function planWindowLabel(window: string): string {
  if (window === "five_hour") return "5 小时";
  if (window === "weekly") return "本周";
  if (window === "monthly") return "本月";
  return window;
}

/** 具体时间点（官方口径）：今天 HH:mm:ss，跨天 MM-DD HH:mm:ss */
export function formatPlanTimestamp(ms: number, now: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? clock : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** 重置时间点（官方风格）：「MM-DD HH:mm:ss 重置」；未知返回 null */
export function formatResetPoint(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  return `${formatPlanTimestamp(resetsAt, now)} 重置`;
}

/** 重置倒计时（悬停提示用）：「X 小时 Y 分后重置」/「已到重置时间」；未知返回 null */
export function formatResetCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const remain = resetsAt - now;
  if (remain <= 0) return "已到重置时间";
  const mins = Math.ceil(remain / 60_000);
  if (mins < 60) return `${mins} 分后重置`;
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 48) return `${hours} 小时${restMins > 0 ? ` ${restMins} 分` : ""}后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时后重置`;
}

/** 进度分档：<70 正常 / 70-90 警示 / ≥90 危急 */
export function quotaBarLevel(usedPercent: number): "ok" | "warn" | "danger" {
  if (usedPercent >= 90) return "danger";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/** 重置卡行文案（单行精简）：「重置卡 5 小时 ×1（10-18 18:48:55 前用） · 周 ×1（…）」；
 *  3 天内临期加「剩 X 天」；不可用/无数据返回 null */
export function resetCardsLine(
  cards: {
    ok: boolean;
    fiveHour: number;
    weekly: number;
    fiveHourExpiresAt?: number | null;
    weeklyExpiresAt?: number | null;
  },
  now: number,
): string | null {
  if (!cards.ok) return null;
  const part = (label: string, count: number, expiresAt?: number | null) => {
    if (count <= 0) return null;
    if (expiresAt == null) return `${label} ×${count}`;
    const ts = formatPlanTimestamp(expiresAt, now);
    if (expiresAt <= now) return `${label} ×${count}（${ts} 已到期限）`;
    const days = Math.ceil((expiresAt - now) / 86_400_000);
    if (days <= 3) return `${label} ×${count}（${ts} 前用，剩 ${days} 天）`;
    return `${label} ×${count}（${ts} 前用）`;
  };
  const parts = [
    part("5 小时", cards.fiveHour, cards.fiveHourExpiresAt),
    part("周", cards.weekly, cards.weeklyExpiresAt),
  ].filter((p): p is string => p != null);
  if (parts.length === 0) return "重置卡 0 张";
  return `重置卡 ${parts.join(" · ")}`;
}

/** 网关是否配了订阅套餐端点（与后端 detect_plan_provider 同口径；骨架占位判断用，
 *  避免没有套餐网关的用户看到闪一下就消失的骨架） */
export function gatewayHasPlanQuota(gateway: {
  slots?:
    | {
        anthropic?: string | null;
        openai?: string | null;
        responses?: string | null;
        gemini?: string | null;
        cursor?: string | null;
      }
    | null;
}): boolean {
  const urls = [
    gateway.slots?.anthropic ?? null,
    gateway.slots?.openai ?? null,
    gateway.slots?.responses ?? null,
    gateway.slots?.gemini ?? null,
    gateway.slots?.cursor ?? null,
  ];
  return urls.some((u): u is string => {
    if (!u) return false;
    const lower = u.toLowerCase();
    return (
      lower.includes("bigmodel.cn") ||
      lower.includes("api.z.ai") ||
      lower.includes("api.kimi.com") ||
      lower.includes("minimaxi.com") ||
      lower.includes("minimax.io")
    );
  });
}

/** 数据时间标注：缓存/回落值显示「数据截至 HH:mm」；新鲜数据返回 null */
export function planQuotaDataAt(queriedAt: number, fromCache: boolean): string | null {
  if (!fromCache) return null;
  const d = new Date(queriedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `数据截至 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
