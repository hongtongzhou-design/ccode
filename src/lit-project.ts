import { parentDir, pathWithin, samePath } from "./path-utils.ts";

/** 沉浸阅读/写笔记时建议添加的项目目录：
 *  PDF 落在当前终端目录内 → 用终端目录（文献库根）；否则用 PDF 所在文件夹。 */
export function suggestLitProjectDir(
  pdfPath: string,
  cwd: string | null | undefined,
  isWindows = false,
): string {
  const file = pdfPath.replace(/[\\/]+$/, "");
  const folder = parentDir(file);
  const root = cwd?.trim() ? cwd.trim().replace(/[\\/]+$/, "") : "";
  if (root && pathWithin(file, root, isWindows)) return root;
  return folder ?? file;
}

/** 家目录、盘符根、文件系统根不宜登记成项目（笔记会写进去）。 */
export function isUnsafeLitProjectDir(
  dir: string,
  home: string | null | undefined,
  isWindows = false,
): boolean {
  const d = dir.trim();
  if (!d) return true;
  const key = d.replace(/[\\/]+$/, "") || d;
  if (/^\/$/.test(key) || /^[A-Za-z]:[\\/]?$/.test(key)) return true;
  if (home?.trim() && samePath(key, home.trim(), isWindows)) return true;
  return false;
}

/** 无研究流程或没有精读步骤时，选段写入项目根 notes/inbox.md。 */
export function notesInboxTarget(cfg: {
  pipelineOptOut?: boolean;
  steps: { workspaceName: string }[];
}): { kind: "workspace"; name: string } | { kind: "project-root" } {
  if (cfg.pipelineOptOut) return { kind: "project-root" };
  const step =
    cfg.steps.find((s) => s.workspaceName === "lit-notes") ?? cfg.steps[1];
  if (step?.workspaceName) return { kind: "workspace", name: step.workspaceName };
  return { kind: "project-root" };
}
