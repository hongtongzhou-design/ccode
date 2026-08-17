/**
 * 每个 agent 的识别色：从现有设计令牌取色（低饱和、状态色系的浅字档），随主题联动。
 * 统计页进度条与对话页列表行 meta 共用（单一出处；新增 agent 在这里加一行）。
 */
export const AGENT_COLORS: Record<string, string> = {
  "claude-code": "var(--color-ok-text)",
  codex: "var(--color-link)",
  gemini: "var(--color-warn-text)",
  qwen: "var(--color-err-text)",
  opencode: "var(--color-add)",
  kimi: "var(--color-tabline)",
  grok: "var(--color-cta-pill-text)",
  codebuddy: "var(--color-done)",
  cursor: "var(--color-cta-bd)",
};

/**
 * 品牌色（固定 hex，不随主题变——同 file-icons.ts 的「固定识别色」先例）：
 * 对话列表的 agent 胶囊用这种色做文字 + 低透明底，扫一眼即可分家。
 * 选色口径（v3.92 调）：低饱和中明度的「雾面色」（高饱和 500 档在浅色主题下发飘显廉价），
 * 尽量贴各家真实品牌色相（Claude 赤陶、Codex 紫、Kimi 青玉…），九家 hue 两两拉开；
 * 胶囊是「色字 + 10% 淡底」，深浅主题都要可读，禁走极端明暗。新 agent 加一行，别撞色。
 */
export const AGENT_BRAND: Record<string, string> = {
  "claude-code": "#D97757", // 赤陶（Claude 官方色）
  kimi: "#0D9488", // 青玉
  codex: "#8B7EC8", // 雾紫
  gemini: "#527EC3", // 灰蓝
  qwen: "#7450C8", // 深紫罗兰
  opencode: "#7A8699", // 石板灰蓝
  codebuddy: "#C45959", // 砖红
  cursor: "#A87F2A", // 暗琥珀
  grok: "#C4506A", // 雾玫红
};

/** 未知 agent 兜底：按 id 哈希取 HSL 色，确定性且不与上方令牌池撞色 */
export function fallbackAgentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 65%)`;
}

export const agentColor = (id: string) =>
  AGENT_COLORS[id] ?? fallbackAgentColor(id);

export const agentBrand = (id: string) =>
  AGENT_BRAND[id] ?? fallbackAgentColor(id);

/** agent 胶囊徽章的内联样式：品牌色文字 + 同色系 10% 底（无描边——描边+彩底+彩字三层叠加
    在浅色主题下显廉价，v3.92 收敛；深浅主题均可读） */
export function agentBrandBadgeStyle(id: string): {
  color: string;
  background: string;
} {
  const c = agentBrand(id);
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 10%, transparent)`,
  };
}
