import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatPlanTimestamp,
  formatResetCountdown,
  formatResetPoint,
  gatewayHasPlanQuota,
  planProviderLabel,
  planGatewayNameVisible,
  planLevelLabel,
  planQuotaDataAt,
  planTabLabel,
  planWindowLabel,
  quotaBarLevel,
  resetCardsLine,
} from "../src/plan-quota.ts";

// 2026-09-19 12:00:00 本地（Asia/Shanghai）的毫秒值——测试统一用显式 now
const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();

test("供应商显示名与切换标签", () => {
  assert.equal(planProviderLabel("zhipu"), "智谱");
  assert.equal(planProviderLabel("kimi"), "Kimi");
  assert.equal(planProviderLabel("minimax"), "MiniMax");
  assert.equal(planProviderLabel("other-x"), "other-x");
  // 同供应商单网关：标签只有供应商名；多网关：追加网关名区分
  assert.equal(planTabLabel({ provider: "kimi", gatewayName: "Kimi 主力" }, 1), "Kimi");
  assert.equal(
    planTabLabel({ provider: "kimi", gatewayName: "Kimi 备用" }, 2),
    "Kimi · Kimi 备用",
  );
});

test("网关名与供应商同义时不显示（GLM 撞智谱徽章）", () => {
  assert.ok(!planGatewayNameVisible("GLM", "zhipu"));
  assert.ok(!planGatewayNameVisible("glm 2", "zhipu"));
  assert.ok(!planGatewayNameVisible("智谱", "zhipu"));
  assert.ok(!planGatewayNameVisible("Kimi", "kimi"));
  assert.ok(!planGatewayNameVisible("MiniMax", "minimax"));
  assert.ok(!planGatewayNameVisible(null, "zhipu"));
  // 有实际区分信息的名字保留
  assert.ok(planGatewayNameVisible("智谱备用", "zhipu"));
  assert.ok(planGatewayNameVisible("Zeta-22", "zhipu"));
  assert.ok(planGatewayNameVisible("公司号", "zhipu"));
  assert.ok(planGatewayNameVisible("Kimi 主力", "kimi"));
});

test("套餐等级精简（GLM 前缀与 Plan 后缀剥掉）", () => {
  assert.equal(planLevelLabel("GLM Coding Max"), "Max");
  assert.equal(planLevelLabel("GLM Coding Lite"), "Lite");
  assert.equal(planLevelLabel("MaxPlan"), "Max");
  assert.equal(planLevelLabel("glm coding pro"), "pro");
  assert.equal(planLevelLabel(null), null);
  assert.equal(planLevelLabel("  "), null);
});

test("窗口名映射与未知值透传", () => {
  assert.equal(planWindowLabel("five_hour"), "5 小时");
  assert.equal(planWindowLabel("weekly"), "本周");
  assert.equal(planWindowLabel("monthly"), "本月");
  assert.equal(planWindowLabel("custom-x"), "custom-x");
});

test("重置时间点为官方风格的具体时刻（精确到秒）", () => {
  const sameDay = new Date(2026, 8, 19, 15, 30, 45).getTime();
  assert.equal(formatPlanTimestamp(sameDay, NOW), "15:30:45");
  const nextDay = new Date(2026, 8, 20, 8, 5, 0).getTime();
  assert.equal(formatPlanTimestamp(nextDay, NOW), "09-20 08:05:00");
  // 窗口重置主显示：具体时间点；倒计时留在悬停
  assert.equal(formatResetPoint(nextDay, NOW), "09-20 08:05:00 重置");
  assert.equal(formatResetPoint(null, NOW), null);
  assert.equal(formatResetCountdown(nextDay, NOW), "20 小时 5 分后重置");
  assert.equal(formatResetCountdown(NOW - 1, NOW), "已到重置时间");
});

test("进度分档边界", () => {
  assert.equal(quotaBarLevel(69.9), "ok");
  assert.equal(quotaBarLevel(70), "warn");
  assert.equal(quotaBarLevel(89.9), "warn");
  assert.equal(quotaBarLevel(90), "danger");
});

test("重置卡行文案（单行精简，精确到秒）", () => {
  const day = 86_400_000;
  assert.equal(
    resetCardsLine(
      { ok: true, fiveHour: 2, weekly: 1, fiveHourExpiresAt: NOW + 2 * day, weeklyExpiresAt: NOW + 40 * day },
      NOW,
    ),
    "重置卡 5 小时 ×2（09-21 12:00:00 前用，剩 2 天） · 周 ×1（10-29 12:00:00 前用）",
  );
  // 无过期数据：只报数量；零张：0 张
  assert.equal(resetCardsLine({ ok: true, fiveHour: 1, weekly: 0 }, NOW), "重置卡 5 小时 ×1");
  assert.equal(resetCardsLine({ ok: true, fiveHour: 0, weekly: 0 }, NOW), "重置卡 0 张");
  assert.equal(resetCardsLine({ ok: false, fiveHour: 3, weekly: 3 }, NOW), null);
  // 已到期限 / 恰好 3 天
  assert.equal(
    resetCardsLine({ ok: true, fiveHour: 1, weekly: 0, fiveHourExpiresAt: NOW - 1 }, NOW),
    "重置卡 5 小时 ×1（11:59:59 已到期限）",
  );
  assert.equal(
    resetCardsLine({ ok: true, fiveHour: 0, weekly: 1, weeklyExpiresAt: NOW + 3 * day }, NOW),
    "重置卡 周 ×1（09-22 12:00:00 前用，剩 3 天）",
  );
});

test("骨架占位判定与后端探测同口径", () => {
  const gw = (url: string) => ({ slots: { anthropic: url } });
  assert.ok(gatewayHasPlanQuota(gw("https://open.bigmodel.cn/api/anthropic")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.z.ai/api/paas/v4")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.kimi.com/coding")));
  assert.ok(gatewayHasPlanQuota(gw("https://api.minimaxi.com/api/paas/v4")));
  assert.ok(gatewayHasPlanQuota({ slots: { openai: "https://api.minimax.io/v1" } }));
  // 普通按量付费端点不命中
  assert.ok(!gatewayHasPlanQuota(gw("https://api.deepseek.com/v1")));
  assert.ok(!gatewayHasPlanQuota(gw("https://api.moonshot.cn/v1")));
  assert.ok(!gatewayHasPlanQuota({ slots: null }));
});

test("缓存数据标注", () => {
  assert.equal(planQuotaDataAt(NOW, false), null);
  assert.equal(planQuotaDataAt(NOW - 3600_000, true), "数据截至 11:00");
});
