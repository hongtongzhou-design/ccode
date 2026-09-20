import type { GitFileDto } from "./types";

/** 开工软门纯逻辑：项目根未提交改动与本步声明输入（inputs/optionalInputs/anyOfInputs 并集）
 *  的相交判定。工作区从本地基准分支 HEAD 建树，未提交的改动带不进去——命中就要在开工前
 *  「存进历史」或二次确认（2026-09-20，与上一步收尾软门同款只确认不阻断）。
 *  输入形态按模板实际写法收敛：目录（notes/）、文件（references.bib）、单层 glob（papers/*.pdf）；
 *  其余带通配符的按字面量比。git 路径恒为 / 分隔，Windows 侧也归一后再比。 */

function normPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 单条输入是否命中一个仓库相对路径文件 */
export function inputPathMatches(input: string, filePath: string): boolean {
  const pat = normPath(input);
  const file = normPath(filePath);
  if (pat === "" || file === "") return false;
  // 单层 *.ext glob（"papers/*.pdf" / "*.pdf"）：目录内（无根时为仓库顶层）直接子文件按扩展名
  const glob = /^(?:(.*)\/)?\*\.([A-Za-z0-9]+)$/.exec(pat);
  if (glob) {
    const dir = (glob[1] ?? "").replace(/\/+$/, "");
    const ext = glob[2].toLowerCase();
    const rest =
      dir === ""
        ? file
        : file.startsWith(`${dir}/`)
          ? file.slice(dir.length + 1)
          : null;
    return (
      rest !== null &&
      !rest.includes("/") &&
      rest.toLowerCase().endsWith(`.${ext}`)
    );
  }
  if (file === pat) return true;
  // 目录输入（"notes/" 或 "notes"）：命中其下任意深度文件；同级前缀名不算（notes2/ ≠ notes/）
  const dir = pat.replace(/\/+$/, "");
  return dir !== "" && file.startsWith(`${dir}/`);
}

/** 改动文件里命中本步输入的子集（保持原顺序，前端就地渲染文件名单） */
export function dirtyInputHits(
  files: readonly GitFileDto[],
  inputs: readonly string[],
): GitFileDto[] {
  const patterns = inputs.map(normPath).filter((p) => p !== "");
  return files.filter((f) =>
    patterns.some((pat) => inputPathMatches(pat, f.path)),
  );
}
