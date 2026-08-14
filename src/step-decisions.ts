import type { StepDecisionDto } from "./types";

/** 决策项答案的落点：任务书草稿 `.ccode/drafts/<工作区名>.md` 里的固定小节。
 *
 *  为什么落草稿而不是单独存一份状态：草稿就是开工合同（开工弹层草稿优先于模板拼装），
 *  人和 agent 读的是同一份文件。答案单独存别处就又多一层要对齐的中间态——
 *  §11.3 机制三的口径是「草稿是源，TASK.md 是开工那一刻的产物快照」，这里不破例。
 *
 *  纯函数 + 可测：解析与写入都不碰 IO，落盘由调用方走 write_task_draft。 */
export const DECISIONS_HEADING = "## 已定方向";

/** 小节内的答案行：`- 问题：答案`（全角冒号，与模板文案同一套标点） */
const ANSWER_LINE = /^-\s*(.+?)：(.*)$/;

/** 定位已定方向小节的行区间 [start, end)；start = -1 表示草稿里还没有这个小节。
 *
 *  小节的结束 = 第一个「既不是空行、也不是答案行」的行。不能图省事写成「下一个 ## 标题或文件末尾」：
 *  小节后面跟的若是没有标题的自由正文，那种写法会把正文一并算进小节，
 *  于是 upsertDecisions 重写小节时把人写的正文删掉（真丢数据），
 *  isDecisionsOnly 也会把有正文的草稿误判成「只有拍板结果」。 */
function locateSection(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => l.trim() === DECISIONS_HEADING);
  if (start < 0) return { start: -1, end: lines.length };
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === "" || ANSWER_LINE.test(t)) continue;
    end = j;
    break;
  }
  return { start, end };
}

/** 读出小节内的答案（保序）：问题 → 答案 */
function readAnswers(lines: string[]): {
  order: string[];
  map: Map<string, string>;
} {
  const order: string[] = [];
  const map = new Map<string, string>();
  for (const line of lines) {
    const m = ANSWER_LINE.exec(line.trim());
    if (!m) continue;
    const q = m[1].trim();
    const answer = m[2].trim();
    if (!q || !answer) continue;
    if (!map.has(q)) order.push(q);
    map.set(q, answer);
  }
  return { order, map };
}

/** 从草稿正文解析已定答案：问题 → 答案。
 *  只认「已定方向」小节内的行——小节外正文里同形的句子不算数，避免把 agent 写的散文吃进来 */
export function parseDecisions(draft: string): Map<string, string> {
  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  if (start < 0) return new Map();
  return readAnswers(lines.slice(start + 1, end)).map;
}

/** 写入/更新答案，返回新草稿全文。
 *  批量入参是为了「全部用推荐值」只写一次盘（也少一次和 agent 并发改草稿的窗口）。
 *  小节已存在 = 原地替换（保留小节外的全部内容）；不存在 = 新建，插在首个一级标题之后，
 *  草稿通常以「# 任务书草稿：<步骤>」开头，已定方向紧随其后是这份合同里最该先被读到的部分。 */
export function upsertDecisions(
  draft: string,
  answers: { q: string; answer: string }[],
): string {
  const clean = answers
    .map((a) => ({ q: a.q.trim(), answer: a.answer.trim() }))
    .filter((a) => a.q && a.answer);
  if (clean.length === 0) return draft;

  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  const { order, map } =
    start >= 0
      ? readAnswers(lines.slice(start + 1, end))
      : { order: [] as string[], map: new Map<string, string>() };

  for (const { q, answer } of clean) {
    if (!map.has(q)) order.push(q);
    map.set(q, answer);
  }
  const section = [
    DECISIONS_HEADING,
    "",
    ...order.map((q) => `- ${q}：${map.get(q)}`),
    "",
  ];

  if (start >= 0) {
    return [...lines.slice(0, start), ...section, ...lines.slice(end)].join(
      "\n",
    );
  }
  const headIdx = lines.findIndex((l) => l.startsWith("# "));
  const at = headIdx >= 0 ? headIdx + 1 : 0;
  const before = lines.slice(0, at);
  // 标题与小节之间留一个空行，不贴着写
  const pad =
    before.length > 0 && before[before.length - 1].trim() !== "" ? [""] : [];
  return [...before, ...pad, ...section, ...lines.slice(at)].join("\n");
}

/** 去掉「已定方向」小节后的剩余正文（trim 后） */
export function stripDecisions(draft: string): string {
  const lines = draft.split(/\r?\n/);
  const { start, end } = locateSection(lines);
  if (start < 0) return draft.trim();
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
}

/** 草稿是不是「只有拍板结果、没有正文」。
 *
 *  这个判定是给开工用的：开工弹层的规则是「草稿非空则草稿全文顶掉模板拼装」（v3.72），
 *  那条规则的前提是草稿里有人/agent 写出来的实质内容。只点了几个选项就生成的草稿
 *  不该把整份简报顶掉——那样 agent 会拿到一份没有任务的任务书。
 *  这种草稿走模板拼装（拼装里已经带上「已定方向」段），只有真写了正文才走草稿全文。
 *
 *  只剩标题行（如 append_step_draft 建的「# 任务书草稿：<步骤>」）也算没有正文。 */
export function isDecisionsOnly(draft: string): boolean {
  if (!draft.trim()) return false;
  if (parseDecisions(draft).size === 0) return false;
  const rest = stripDecisions(draft)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()));
  return rest.length === 0;
}

/** 已定方向按模板顺序排成 TASK.md 用的数组（模板里没有的问题排在后面，不丢人手写的条目） */
export function orderedAnswers(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): { q: string; answer: string }[] {
  const out: { q: string; answer: string }[] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    const q = d.q.trim();
    const answer = answered.get(q);
    if (answer) {
      out.push({ q, answer });
      seen.add(q);
    }
  }
  for (const [q, answer] of answered) {
    if (!seen.has(q)) out.push({ q, answer });
  }
  return out;
}

/** 还没拍板的决策项（顺序同模板）：节点标题的「N 件事」与「全部用推荐值」都按它算 */
export function unansweredDecisions(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): StepDecisionDto[] {
  return decisions.filter((d) => !answered.has(d.q.trim()));
}

/** 「全部用推荐值」要写入的答案：未答项取首个选项（模板里首项即推荐值）；
 *  已答的一律不动——用户显式选过的不该被一键覆盖 */
export function recommendedAnswers(
  decisions: StepDecisionDto[],
  answered: Map<string, string>,
): { q: string; answer: string }[] {
  return unansweredDecisions(decisions, answered)
    .filter((d) => d.options.length > 0)
    .map((d) => ({ q: d.q.trim(), answer: d.options[0] }));
}
