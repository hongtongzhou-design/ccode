/**
 * 对话页筛选纯逻辑（v3.88）。
 *
 * 背景：`SessionMetaDto` 里早就有 stepName / taskName / workspace / live / pinned /
 * updatedAt 这些维度，**一个都没进筛选 UI**；唯一做进 UI 的 agent 维度恰恰最低频
 * （用户按项目、按时间、按状态找，不按 agent 找）。这里补上高频的状态/时间快筛，
 * 以及把搜索框升级成「输入 → 结构化建议 → 落成可叠加 chip」。
 *
 * 与 DOM/Tauri 解耦，node --test 直接测。
 */
import { pathKey } from "./path-utils.ts";
import type { SessionMetaDto } from "./types";

/** 一行 chip 快筛的 id（互不排斥，可与作用域 chip 叠加） */
export type QuickFilterId =
  | "pinned"
  | "live"
  | "today"
  | "week"
  | "internal"
  | "archived";

export interface QuickFilterDef {
  id: QuickFilterId;
  label: string;
  title: string;
}

/** 固定展示顺序：状态在前、时间居中、范围在后 */
export const QUICK_FILTERS: readonly QuickFilterDef[] = [
  { id: "pinned", label: "⚑ 保留", title: "只看已保留（pin）的对话" },
  { id: "live", label: "进行中", title: "只看仍在运行的会话" },
  { id: "today", label: "今天", title: "今天有更新的对话" },
  { id: "week", label: "近 7 天", title: "近 7 天有更新的对话" },
  { id: "internal", label: "内部 AI", title: "只看 Ccode 内部 AI 的会话" },
  { id: "archived", label: "已归档", title: "把已归档的对话也列出来" },
];

/** 作用域筛选：搜索建议点选后落成的 chip，可叠加 */
export interface ScopeChip {
  kind: "project" | "step" | "task" | "agent";
  /** 匹配值（projectPath / stepName / taskName / agent id） */
  value: string;
  /** 展示用短标签 */
  label: string;
}

function dayStart(offsetDays: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * 86_400_000;
}

/** 会话的时间戳（updatedAt 优先，回落 createdAt）；都没有返回 null */
export function sessionTime(s: SessionMetaDto): number | null {
  const raw = s.updatedAt ?? s.createdAt;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/**
 * 应用快筛 + 作用域 chip。
 *
 * 口径要点：
 * - `archived` 是**放宽**（把归档的也列出来），不是「只看归档」——与既有「显示已归档」开关同义；
 *   没勾时一律排除归档项。
 * - `internal` 是**收窄**（只看内部 AI）；没勾时排除内部会话，与既有列表口径一致。
 * - `today` / `week` 同时勾选取并集里更宽的那个（week 覆盖 today）。
 * - 作用域 chip 之间**同类取或、异类取与**：两个项目 chip = 这两个项目里的；
 *   项目 chip + 步骤 chip = 该项目里该步骤的。
 */
export function applySessionFilters(
  sessions: readonly SessionMetaDto[],
  quick: ReadonlySet<QuickFilterId>,
  scopes: readonly ScopeChip[],
  liveKeys: ReadonlySet<string>,
  now: number = Date.now(),
): SessionMetaDto[] {
  const cutoff = quick.has("week")
    ? dayStart(6, now)
    : quick.has("today")
      ? dayStart(0, now)
      : null;
  const byKind = new Map<ScopeChip["kind"], string[]>();
  for (const c of scopes) {
    const list = byKind.get(c.kind) ?? [];
    list.push(c.value);
    byKind.set(c.kind, list);
  }
  return sessions.filter((s) => {
    if (!quick.has("archived") && s.archived) return false;
    if (quick.has("internal") ? !s.internal : s.internal) return false;
    if (quick.has("pinned") && !s.pinned) return false;
    if (quick.has("live") && !s.live && !liveKeys.has(`${s.agent}\n${s.sessionId}`))
      return false;
    if (cutoff !== null) {
      const t = sessionTime(s);
      if (t === null || t < cutoff) return false;
    }
    for (const [kind, values] of byKind) {
      const hit = values.some((v) => {
        if (kind === "project") return s.projectPath === v;
        if (kind === "step") return s.stepName === v;
        if (kind === "task") return s.taskName === v;
        return s.agent === v;
      });
      if (!hit) return false;
    }
    return true;
  });
}

/**
 * 搜索建议：从当前会话集里提取匹配查询的结构化维度，点选即落成 chip。
 * 取代原先「展开手风琴 → 找 agent → 展开 → 找项目」的三次点击钻取。
 * 每类最多 `perKind` 条，避免下拉过长。
 */
export function buildScopeSuggestions(
  sessions: readonly SessionMetaDto[],
  query: string,
  perKind = 4,
): ScopeChip[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const out: ScopeChip[] = [];
  const push = (kind: ScopeChip["kind"], value: string, label: string) => {
    const v = value.trim();
    if (!v || !v.toLowerCase().includes(q)) return;
    const key = `${kind}:${v}`;
    if (seen.has(key)) return;
    if (out.filter((c) => c.kind === kind).length >= perKind) return;
    seen.add(key);
    out.push({ kind, value: v, label });
  };
  // 顺序 = 用户找东西的常见顺序：项目 → 步骤 → 卡片 → agent
  for (const s of sessions) push("project", s.projectPath, baseName(s.projectPath));
  for (const s of sessions) push("step", s.stepName ?? "", s.stepName ?? "");
  for (const s of sessions) push("task", s.taskName ?? "", s.taskName ?? "");
  for (const s of sessions) push("agent", s.agent, s.agent);
  return out;
}

/** 路径末段（项目名展示用；与其余页面 pathBaseName 同口径） */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Ccode 无头 AI 的临时 cwd 名：`ccode-ai-<uuid>`（与 ai.rs 命名同步）。 */
const CCODE_AI_TEMP_RE =
  /^ccode-ai-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 是否为 Ccode 自建的无头 AI 临时目录。
 * 用量统计仍只认 provenance；对话页范围用它把已过期登记的临时目录从「项目」里拿开。
 */
export function isCcodeAiTempCwd(path: string): boolean {
  return CCODE_AI_TEMP_RE.test(baseName(path));
}

/** 对话列表是否按内部 AI 归并：后端标记，或 Ccode 自建临时 cwd（登记被清后会话还在）。 */
export function sessionLooksInternal(s: { internal: boolean; projectPath: string }): boolean {
  return s.internal || isCcodeAiTempCwd(s.projectPath);
}

export interface ProjectGroup {
  /** 组内第一条会话的原始路径（显示/回写用，不拿 pathKey） */
  path: string;
  list: SessionMetaDto[];
}

function latestStamp(list: readonly SessionMetaDto[]): string {
  let max = "";
  for (const s of list) {
    const t = s.updatedAt ?? s.createdAt ?? "";
    if (t > max) max = t;
  }
  return max;
}

/**
 * 跨 Agent 按项目路径分组（对话页「范围 → 按项目」）。
 * 比较键走 pathKey（Windows 折叠大小写、剥 verbatim）；空路径不进组。
 */
export function groupSessionsByProjectPath(
  sessions: readonly SessionMetaDto[],
  isWindows = false,
): ProjectGroup[] {
  const byKey = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const p = s.projectPath?.trim();
    if (!p || isCcodeAiTempCwd(p)) continue;
    const key = pathKey(p, isWindows);
    const g = byKey.get(key);
    if (g) g.list.push(s);
    else byKey.set(key, { path: p, list: [s] });
  }
  return [...byKey.values()].sort((a, b) =>
    latestStamp(b.list).localeCompare(latestStamp(a.list)),
  );
}

export const SCOPE_KIND_LABEL: Record<ScopeChip["kind"], string> = {
  project: "项目",
  step: "步骤",
  task: "卡片",
  agent: "Agent",
};
