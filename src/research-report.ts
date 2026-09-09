import type { ProjectStepDto, RunScriptDto } from "./types";

export type ResearchReportKind = "decision" | "acceptance";
export interface ReportSection { heading: string; text: string; line: number }
export interface ResearchReport {
  path: string;
  sections: ReportSection[];
  truncated: boolean;
  revision: string | null;
}

/** Only explicit report sections, never TASK instructions, examples in fences, or inferred verdicts. */
export function extractResearchSections(text: string, kind: ResearchReportKind): ReportSection[] {
  const lines = text.split(/\r?\n/);
  const found: ReportSection[] = [];
  const matches = kind === "decision"
    ? /^(?:决策摘要|方案比较|待决事项)(?:[（(:：\s]|$)/
    : /^(?:验收摘要|质量状态(?:与未决事项)?|未决(?:事项|问题)|复算与验证|问题闭环)(?:[（(:：\s]|$)/;
  let fence: string | null = null;
  let current: { heading: string; level: number; line: number; body: string[] } | null = null;
  const finish = () => {
    if (current) {
      const body = current.body.join("\n").trim();
      if (body) found.push({ heading: current.heading, text: body, line: current.line });
    }
    current = null;
  };
  lines.forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      if (current && level <= current.level) finish();
      if (matches.test(heading[2])) {
        finish();
        current = { heading: heading[2], level, line: index + 1, body: [] };
      } else if (current) current.body.push(line);
      return;
    }
    // Some existing reports use “决策摘要：A…; B…” instead of a heading.
    const inline = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([^：:]+?)(?:\*\*)?[：:]\s*(.+)$/);
    if (!current && inline && matches.test(inline[1])) {
      found.push({ heading: inline[1], text: inline[2], line: index + 1 });
    } else if (current) current.body.push(line);
  });
  finish();
  return found;
}

/** Refuse escape paths before requesting local previews (the backend is the final authority). */
export function researchRelativePath(path: string): string | null {
  const value = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || /[:\x00-\x1f]/.test(value) || value.split("/").some((p) => p === ".." || p === ".")) return null;
  return value;
}

export function researchAbsolutePath(root: string, path: string): string {
  const relative = researchRelativePath(path);
  if (!relative || relative.includes("*")) throw new Error("报告路径必须位于项目内且不能包含通配符");
  return `${root.replace(/[\\/]+$/, "")}/${relative}`;
}

export function researchReportPatterns(step: ProjectStepDto, kind: ResearchReportKind): string[] {
  const patterns = kind === "decision"
    ? [...(step.inputs ?? []), ...(step.optionalInputs ?? []), ...(step.anyOfInputs ?? []).flat()]
    : step.expectedArtifacts;
  return [...new Set(patterns.filter((p) => {
    const safe = researchRelativePath(p);
    return safe && !/(?:^|\/)TASK\.md$/i.test(safe) && (/\.(?:md|markdown|txt)$/i.test(safe) || safe.endsWith("/") || safe.includes("*"));
  }))];
}

/** Only named user/project scripts, not command fragments scraped from a report. */
export function reproductionScripts(scripts: RunScriptDto[]): RunScriptDto[] {
  return scripts.filter((s) => /reproduc|复现|复算/i.test(s.name) && !!s.command.trim());
}

export function reproductionEntrypoints(step: ProjectStepDto): string[] {
  return [...new Set([...step.expectedArtifacts, ...(step.inputs ?? []), ...(step.optionalInputs ?? [])]
    .filter((p) => /(?:^|\/)reproduce\.(?:py|r|R|js|ts|sh)$/.test(p) && researchRelativePath(p)))];
}

export interface ReproductionContract {
  entry: string;
  interpreter: "python";
  subcommand: string | null;
  inputFlag: string;
  outputFlag: string;
  /** independent = 输出必须在输入项目之外 */
  outputPlacement: "independent";
  resultFile: string;
  cwd: "input";
}

const CONTRACT_LINE = /^\s*(?:#|\/\/)\s*MESA_REPRODUCE:\s*(.+)$/i;

/** 读取脚本里的明确约定；没有约定时，只对带 reproduce 子命令的 Python 入口给默认合同。 */
export function parseReproductionContract(entry: string, source: string): ReproductionContract | null {
  const safe = researchRelativePath(entry);
  if (!safe) return null;
  for (const line of source.split(/\r?\n/).slice(0, 40)) {
    const match = CONTRACT_LINE.exec(line);
    if (!match) continue;
    try {
      const raw = JSON.parse(match[1]) as Partial<ReproductionContract>;
      if (raw.outputPlacement !== "independent") return null;
      if (raw.interpreter !== "python") return null;
      const resultFile = typeof raw.resultFile === "string" ? researchRelativePath(raw.resultFile) : null;
      if (!resultFile) return null;
      return {
        entry: safe,
        interpreter: "python",
        subcommand: typeof raw.subcommand === "string" && raw.subcommand.trim() ? raw.subcommand.trim() : null,
        inputFlag: raw.inputFlag === "--input" ? "--input" : "--input",
        outputFlag: raw.outputFlag === "--output" ? "--output" : "--output",
        outputPlacement: "independent",
        resultFile,
        cwd: "input",
      };
    } catch {
      return null;
    }
  }
  if (!safe.endsWith(".py")) return null;
  if (!/\badd_parser\(\s*['"]reproduce['"]/.test(source) && !/\breproduce\s+--input/.test(source)) return null;
  return {
    entry: safe,
    interpreter: "python",
    subcommand: "reproduce",
    inputFlag: "--input",
    outputFlag: "--output",
    outputPlacement: "independent",
    resultFile: "verification.json",
    cwd: "input",
  };
}

export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 工作目录 = 输入项目；输出必须是独立目录。 */
export function reproductionCommandFromContract(
  contract: ReproductionContract,
  input: string,
  output: string,
  windows: boolean,
): string {
  const python = windows ? "python" : "python3";
  const args = [quoteShellArg(contract.entry)];
  if (contract.subcommand) args.push(quoteShellArg(contract.subcommand));
  args.push(contract.inputFlag, quoteShellArg(input), contract.outputFlag, quoteShellArg(output));
  return `${python} ${args.join(" ")}`;
}

// 保留给旧测试：不再把输出默认写进项目内。
export function reproductionCommand(entry: string, output: string, windows: boolean): string {
  const contract = parseReproductionContract(entry, "add_parser('reproduce')");
  if (!contract) return "";
  return reproductionCommandFromContract(contract, ".", output, windows);
}
