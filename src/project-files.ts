import { parentDir, pathWithin, samePath } from "./path-utils.ts";
import { officeDocKind, type OfficeDocKind } from "./work-mode.ts";

/** 项目文件页就地预览形态：与运行页右栏同一套分流。 */
export type ProjectFilePreviewKind =
  | "pdf"
  | "image"
  | "xlsx"
  | "docx"
  | "legacy-doc"
  | "text";

export type ProjectFileFilter = "all" | OfficeDocKind;

export function fileMatchesProjectFilter(
  path: string,
  filter: ProjectFileFilter,
): boolean {
  if (filter === "all") return true;
  return officeDocKind(path) === filter;
}

export function flattenVisibleFiles<T extends { path: string; isDir: boolean }>(
  cache: Record<string, readonly T[] | undefined>,
  root: string,
  expanded: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  const walk = (dir: string) => {
    for (const entry of cache[dir] ?? []) {
      if (entry.isDir) {
        if (expanded.has(entry.path)) walk(entry.path);
      } else {
        out.push(entry);
      }
    }
  };
  walk(root);
  return out;
}

/** 从项目根到文件父目录、需要展开的目录链（不含根）。路径不在根内则空。 */
export function ancestorDirsToReveal(
  root: string,
  filePath: string,
  isWindows = false,
): string[] {
  if (!pathWithin(filePath, root, isWindows)) return [];
  const out: string[] = [];
  let cur = parentDir(filePath);
  while (
    cur &&
    pathWithin(cur, root, isWindows) &&
    !samePath(cur, root, isWindows)
  ) {
    out.unshift(cur);
    cur = parentDir(cur);
  }
  return out;
}

export function neighborFile<T extends { path: string }>(
  files: readonly T[],
  currentPath: string | null | undefined,
  delta: -1 | 1,
): T | null {
  if (files.length === 0) return null;
  const index = currentPath
    ? files.findIndex((file) => file.path === currentPath)
    : -1;
  const next = index < 0 ? (delta > 0 ? 0 : files.length - 1) : index + delta;
  if (next < 0 || next >= files.length) return null;
  return files[next] ?? null;
}

export function projectFilePreviewKind(path: string): ProjectFilePreviewKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "text";
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp" ||
    ext === "svg"
  ) {
    return "image";
  }
  if (
    ext === "xlsx" ||
    ext === "xlsm" ||
    ext === "xls" ||
    ext === "ods" ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    return "xlsx";
  }
  if (ext === "docx") return "docx";
  if (ext === "doc" || ext === "rtf") return "legacy-doc";
  return "text";
}

const ARTIFACT_TEXT_EXTS = new Set(["md", "markdown", "txt", "ris", "bib"]);

/** 产物核验点开：文本走编辑弹层，pdf/docx/表格/图就地预览，其余才跳运行页。 */
export function artifactPreviewSurface(
  path: string,
): "text" | "media" | "jump" {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (ARTIFACT_TEXT_EXTS.has(ext)) return "text";
  const kind = projectFilePreviewKind(path);
  if (
    kind === "pdf" ||
    kind === "docx" ||
    kind === "xlsx" ||
    kind === "image"
  ) {
    return "media";
  }
  return "jump";
}
