/**
 * 会话导入向导纯逻辑：状态文案、目标目录预填、可否执行。
 * 不读文件系统、不读平台，isWindows 由调用方传入。
 */
import { pathKey, samePath } from "./path-utils.ts";
import type { ImportPreviewEntryDto } from "./types.ts";

export function pathBasename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** B 机已注册项目里文件夹同名者优先；否则只给出末段名供选择器提示。 */
export function suggestTargetDir(
  originalPath: string,
  registeredPaths: string[],
  isWindows = false,
): { recommended: string | null; fallbackName: string } {
  const fallbackName = pathBasename(originalPath);
  if (!fallbackName) return { recommended: null, fallbackName: "" };
  const want = pathKey(fallbackName, isWindows);
  const recommended =
    registeredPaths.find((p) => pathKey(pathBasename(p), isWindows) === want) ??
    null;
  return { recommended, fallbackName };
}

export function importStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "可导入";
    case "needs-path":
      return "需选目录";
    case "conflict":
      return "已存在，将跳过";
    case "unsupported":
      return "不支持";
    default:
      return status;
  }
}

export type EntryDecision = { skip: boolean; targetDir: string };

/** 工作区会话：文件 cwd 与列表主仓路径不是同一处。 */
export function cwdDiffersFromProject(
  e: { cwd?: string | null; projectPath: string },
  isWindows = false,
): boolean {
  const cwd = e.cwd?.trim();
  if (!cwd || !e.projectPath.trim()) return false;
  return !samePath(cwd, e.projectPath, isWindows);
}

export function defaultDecisions(
  entries: ImportPreviewEntryDto[],
  registeredPaths: string[],
  isWindows = false,
): Record<number, EntryDecision> {
  const out: Record<number, EntryDecision> = {};
  for (const e of entries) {
    if (e.status === "conflict" || e.status === "unsupported") {
      out[e.index] = { skip: true, targetDir: e.projectPath || "" };
      continue;
    }
    if (e.status === "needs-path") {
      // 推荐用主仓名去对已注册项目；工作树目录名对不上。
      const { recommended } = suggestTargetDir(
        e.projectPath,
        registeredPaths,
        isWindows,
      );
      out[e.index] = { skip: false, targetDir: recommended ?? "" };
    } else {
      // 本机路径还在：默认落到文件真实 cwd，工作区会话才不会被改写成主仓。
      const cwd = e.cwd?.trim();
      out[e.index] = { skip: false, targetDir: cwd || e.projectPath || "" };
    }
  }
  return out;
}

/** needs-path 且未跳过的条目必须有目标目录。 */
export function canApply(
  entries: ImportPreviewEntryDto[],
  decisions: Record<number, EntryDecision>,
): { ok: boolean; missing: number[] } {
  const missing: number[] = [];
  for (const e of entries) {
    const d = decisions[e.index];
    if (!d || d.skip) continue;
    if (e.status === "unsupported" || e.status === "conflict") continue;
    if (e.status === "needs-path" && !d.targetDir.trim()) {
      missing.push(e.index);
    }
  }
  return { ok: missing.length === 0, missing };
}

export const SECRET_EXPORT_WARNING =
  "导出会话包是原文拷贝，文件里可能含密钥或路径。只放在本机可信位置，分享前请自查。密钥、网关和连接配置不会进包。";
