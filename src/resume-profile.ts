/**
 * 恢复会话的 profile 挑选纯逻辑（2026-08-20，codex 内联 provider 修复；
 * 2026-09-05 起 Codex 三条渠道分开，避免官方/网关/客户端串台）。
 *
 * 背景：codex 的自定义接入是 Ccode 启动时用 `-c` 内联定义的 provider（名字就叫 "ccode"），
 * 不写用户全局配置；rollout 元信息记录 model_provider="ccode"。恢复会话时 codex 要重新
 * 解析这个名字——若恢复用的配置不带 Base URL（官方账号型/其他），-c 定义不注入，
 * codex 直接报 "Model provider `ccode` not found" 拒绝启动。
 *
 * Codex 会话的 model_provider 还可能是：
 * - `openai`：ChatGPT 内置渠道（Ccode「官方账号」启动注入的也是这个）
 * - 其他名字（如磁盘 `custom`）：Codex 客户端 / 全局 config.toml 自己的渠道
 *
 * 三条路认证不同。把客户端 `custom` 会话自动接到「官方账号」会强制打 api.openai.com
 * 且清掉网关密钥，报 401 Missing bearer；同一会话在客户端却能继续。
 *
 * 规则：
 * - provider=ccode / ccode-<短id>：只在带 Base URL 的配置里挑（按网关短 id 优先）
 * - provider=openai：挑官方账号；官方未登录则改挑网关（能真正发请求的）
 * - 其他非空 provider：只挑网关，绝不自动落到官方
 * - 无记录：未确认官方已登录时跳过官方
 * 兼容池为空时回落全池（宁可用旧行为试，也不拦死——比如配置被删过的历史会话）。
 *
 * 软停用（settings.hiddenProfiles）：这里是「自动挑选」路径，停用项不参与——wishedId
 * 是「上次使用」的记忆而非用户当下的显式选择，指向停用项同样跳过。全被停用时回落
 * 含停用项的池（好过恢复不出来）；用户显式手选停用项不经过本函数，不受影响。
 */

export function isCcodeProvider(provider: string | null | undefined): boolean {
  return provider === "ccode" || !!provider?.startsWith("ccode-");
}

export function isOfficialProfile(p: {
  accountType?: string | null;
  baseUrl?: string | null;
}): boolean {
  if (p.accountType === "official") return true;
  if (p.accountType === "api") return false;
  return !p.baseUrl?.trim();
}

export type CodexResumeKind = "gateway" | "chatgpt" | "disk" | "unknown";

export function codexResumeKind(
  provider: string | null | undefined,
): CodexResumeKind {
  const p = provider?.trim() ?? "";
  if (!p) return "unknown";
  if (isCcodeProvider(p)) return "gateway";
  if (p === "openai") return "chatgpt";
  return "disk";
}

/** 对话页渠道芯片：空串 = 不展示（未知且不必吓人）。 */
export function codexResumeKindLabel(
  kind: CodexResumeKind,
  provider?: string | null,
): string {
  switch (kind) {
    case "gateway":
      return "Ccode 网关";
    case "chatgpt":
      return "ChatGPT 官方";
    case "disk": {
      const name = provider?.trim();
      return name ? `Codex 客户端 · ${name}` : "Codex 客户端";
    }
    default:
      return "";
  }
}

const CODEX_CHANNEL_TIP: Record<CodexResumeKind, string> = {
  gateway: "这条对话是 Ccode 用网关配置启动的，在本应用里继续走同一条网关。",
  chatgpt:
    "这条对话走 ChatGPT 官方渠道。在 Ccode 里继续需要已登录官方账号；没登录请改选网关，或到连接页登录。",
  disk: "这条对话是 Codex 客户端（或全局 config.toml）自己的渠道。在客户端打开可原样继续；在 Ccode 里继续会改用网关配置，不会改成官方账号。",
  unknown: "",
};

export function codexSessionChannelChip(
  provider: string | null | undefined,
): { label: string; tip: string } | null {
  const kind = codexResumeKind(provider);
  const label = codexResumeKindLabel(kind, provider);
  if (!label) return null;
  return { label, tip: CODEX_CHANNEL_TIP[kind] };
}

/** 自动预选：官方未登录（或尚未探测）时跳过官方账号，只留网关；没有网关才回落官方。 */
export function skipDisconnectedOfficial<T extends {
  accountType?: string | null;
  baseUrl?: string | null;
}>(profiles: readonly T[], officialConnected?: boolean | null): T[] {
  if (officialConnected === true) return [...profiles];
  const rest = profiles.filter((p) => !isOfficialProfile(p));
  return rest.length > 0 ? rest : [...profiles];
}

export function pickResumeProfile<
  T extends {
    id: string;
    agent: string;
    baseUrl: string | null;
    gatewayId?: string | null;
    accountType?: string | null;
  },
>(
  profiles: T[],
  agentId: string,
  provider: string | null | undefined,
  wishedId: string | null | undefined,
  hiddenIds?: readonly string[],
  opts?: { officialConnected?: boolean },
): T | null {
  const all = profiles.filter((p) => p.agent === agentId);
  const gateways = all.filter((p) => !!p.baseUrl?.trim());
  const officials = all.filter(isOfficialProfile);
  const derived = provider?.startsWith("ccode-")
    ? provider.slice("ccode-".length)
    : null;
  const byGateway =
    derived
      ? all.filter((p) => {
          const hex = (p.gatewayId ?? "").replace(/-/g, "");
          return hex.startsWith(derived);
        })
      : [];

  let compat: T[];
  if (isCcodeProvider(provider)) {
    compat =
      derived && byGateway.length > 0
        ? byGateway
        : gateways.length > 0
          ? gateways
          : all;
  } else if (agentId === "codex") {
    const kind = codexResumeKind(provider);
    const connected = opts?.officialConnected;
    if (kind === "chatgpt") {
      compat =
        connected === false
          ? gateways.length > 0
            ? gateways
            : officials
          : officials.length > 0
            ? officials
            : all;
    } else if (kind === "disk") {
      compat = gateways.length > 0 ? gateways : all;
    } else {
      // 无记录：没确认官方已登录就不要自动走 ChatGPT 通道
      compat =
        connected === true
          ? all
          : gateways.length > 0
            ? gateways
            : all;
    }
  } else {
    compat = all;
  }

  const pool = compat.length > 0 ? compat : all;
  const visible = pool.filter((p) => !(hiddenIds ?? []).includes(p.id));
  const finalPool = visible.length > 0 ? visible : pool;
  return finalPool.find((p) => p.id === wishedId) ?? finalPool[0] ?? null;
}
