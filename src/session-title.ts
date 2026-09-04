/**
 * 会话列表展示标题：去掉 URL / 中断提示 / CLI resume /「未命名」噪声，
 * 取首句短标题。自定义标题原样保留。不调用 AI、不写回源文件。
 */
function interruptedRe() {
  return /\[?\s*request interrupted by user\s*\]?|请求(?:已)?中断|被用户中断/gi;
}
const CLI_RESUME_RE =
  /^(claude|codex|gemini|qwen|opencode|kimi|cursor|grok|codebuddy)(?:\s+code)?\s+--resume\b/i;
function urlRe() {
  return /https?:\/\/\S+/gi;
}
const LEADING_PROMPT_RE = /^(请你|请|帮我|我想|我要|麻烦你|麻烦|读一下|看一下)+/;
const CLAUSE_SPLIT_RE = /之后|然后|并且|另外|针对|。|！|？|(?<=\w)\.(?=\s)|!|\?/;

function isUnnamedRaw(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("未命名对话")) return true;
  return /^(untitled(?: session)?|session[_-]?)\b/i.test(t);
}

export interface TidySessionTitle {
  title: string;
  interrupted: boolean;
  unnamed: boolean;
}

export function sessionIsInterrupted(text: string | null | undefined): boolean {
  if (!text) return false;
  return interruptedRe().test(text);
}

function clampTitle(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return "";
  const cjk = chars.filter((c) => (c.codePointAt(0) ?? 0) > 0xff).length;
  const max = cjk >= chars.length / 2 ? 16 : 40;
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

function fileBaseName(p: string): string {
  const cleaned = p.replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
  const segs = cleaned.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || cleaned;
}

/** 绝对路径换成文件名，避免列表被 /Users/... 撑成「看这份文件：/」。
 *  前看不是文件名字符，避免误伤相对路径 src/app.tsx。 */
const ABS_FS_RE =
  /(?<![A-Za-z0-9._-])(?:"((?:[A-Za-z]:[\\/]|\/|~\/)[^"]+)"|'((?:[A-Za-z]:[\\/]|\/|~\/)[^']+)'|(?:[A-Za-z]:[\\/]|\/|~\/)[^\s"'，。；！？]+)/g;

export function replaceAbsFsPaths(text: string): string {
  return text.replace(ABS_FS_RE, (full, dquoted: string | undefined, squoted: string | undefined) => {
    return fileBaseName(dquoted ?? squoted ?? full);
  });
}

/** 去掉噪声后的首句；不够成标题则返回 null。 */
export function tidySessionText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.replace(urlRe(), " ").replace(interruptedRe(), " ");
  text = replaceAbsFsPaths(text);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  text = text.split("\n")[0]?.trim() ?? "";
  if (!text || CLI_RESUME_RE.test(text) || isUnnamedRaw(text)) return null;
  const clause = text.split(CLAUSE_SPLIT_RE)[0]?.trim() ?? "";
  text = clause || text;
  const stripped = text.replace(LEADING_PROMPT_RE, "").trim();
  if ([...stripped].length >= 4) text = stripped;
  const parts = text.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "";
  if (parts.length > 1 && [...first].length >= 4 && [...first].length <= 16) {
    text = first;
  }
  text = clampTitle(text);
  return text || null;
}

export function tidySessionTitle(session: {
  customTitle?: string | null;
  title?: string | null;
  summary?: string | null;
}): TidySessionTitle {
  const custom = session.customTitle?.trim() ?? "";
  if (custom) {
    return { title: custom, interrupted: false, unnamed: false };
  }
  const interrupted =
    sessionIsInterrupted(session.title) ||
    sessionIsInterrupted(session.summary);
  const fromTitle = tidySessionText(session.title);
  if (fromTitle) return { title: fromTitle, interrupted, unnamed: false };
  const fromSummary = tidySessionText(session.summary);
  if (fromSummary) return { title: fromSummary, interrupted, unnamed: false };
  return { title: "未命名对话", interrupted, unnamed: true };
}
