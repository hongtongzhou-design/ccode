/**
 * 项目区「问 AI」：第一次选 Agent / 配置 / 模型，可设为默认。
 * 存储与 pending 纯逻辑，弹层在 AskAiModal。
 */

const KEY = "ccode.askAi";

export interface AskAiFile {
  path: string;
  name: string;
  cwd: string;
  root: string;
  reuseKey: string;
  /** 覆盖默认「请看这份文件」；空串 = 不预填（项目级新对话） */
  prompt?: string;
  /** 默认：有 path 就开右栏预览 */
  preview?: boolean;
}

export interface AskAiRemembered {
  agentId: string;
  profileId: string;
  model: string;
  useDefault: boolean;
}

export function loadAskAiRemembered(): AskAiRemembered | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AskAiRemembered>;
    if (!v || typeof v !== "object") return null;
    if (typeof v.agentId !== "string" || typeof v.profileId !== "string")
      return null;
    return {
      agentId: v.agentId,
      profileId: v.profileId,
      model: typeof v.model === "string" ? v.model : "",
      useDefault: v.useDefault === true,
    };
  } catch {
    return null;
  }
}

export function saveAskAiRemembered(r: AskAiRemembered): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    /* 隐私模式 */
  }
}

export function askAiCanSkip(
  remembered: AskAiRemembered | null,
  profiles: readonly { id: string }[],
): boolean {
  if (!remembered?.useDefault || !remembered.agentId || !remembered.profileId)
    return false;
  return profiles.some((p) => p.id === remembered.profileId);
}

export function buildAskAiPending(
  file: AskAiFile,
  choice: { agentId: string; profileId: string; model: string },
) {
  const hasFile = file.path.trim().length > 0;
  const quoted = hasFile && /\s/.test(file.path) ? `"${file.path}"` : file.path;
  let initialPrompt: string | undefined;
  if (file.prompt !== undefined) {
    initialPrompt = file.prompt.trim() ? file.prompt : undefined;
  } else if (hasFile) {
    initialPrompt = `请看这份文件：${quoted}`;
  }
  const wantPreview = file.preview !== false && hasFile;
  return {
    cwd: file.cwd,
    extraEnv: {},
    title: file.name,
    agentId: choice.agentId,
    profileId: choice.profileId,
    // 空串也要带上：缺省会被启动栏上次的模型（常是中转 DeepSeek）顶掉
    model: choice.model,
    initialPrompt,
    autoStart: !!choice.profileId,
    previewPath: wantPreview ? file.path : undefined,
    previewRoot: wantPreview ? file.root : undefined,
    reuseKey: file.reuseKey,
  };
}
