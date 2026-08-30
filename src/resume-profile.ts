/**
 * 恢复会话的 profile 挑选纯逻辑（2026-08-20，codex 内联 provider 修复）。
 *
 * 背景：codex 的自定义接入是 Ccode 启动时用 `-c` 内联定义的 provider（名字就叫 "ccode"），
 * 不写用户全局配置；rollout 元信息记录 model_provider="ccode"。恢复会话时 codex 要重新
 * 解析这个名字——若恢复用的配置不带 Base URL（官方账号型/其他），-c 定义不注入，
 * codex 直接报 "Model provider `ccode` not found" 拒绝启动。
 *
 * 规则：会话 provider="ccode" 时只在带 Base URL 的配置里挑；其余情况维持原顺序
 * （调用方传入的期望 id → 该 agent 首个配置）。兼容池为空时回落全池（宁可用旧行为试，
 * 也不拦死——比如配置被删过的历史会话）。
 *
 * 软停用（settings.hiddenProfiles）：这里是「自动挑选」路径，停用项不参与——wishedId
 * 是「上次使用」的记忆而非用户当下的显式选择，指向停用项同样跳过。全被停用时回落
 * 含停用项的池（好过恢复不出来）；用户显式手选停用项不经过本函数，不受影响。
 */
export function isCcodeProvider(provider: string | null | undefined): boolean {
  return provider === "ccode" || !!provider?.startsWith("ccode-");
}

export function pickResumeProfile<
  T extends {
    id: string;
    agent: string;
    baseUrl: string | null;
    gatewayId?: string | null;
  },
>(
  profiles: T[],
  agentId: string,
  provider: string | null | undefined,
  wishedId: string | null | undefined,
  hiddenIds?: readonly string[],
): T | null {
  const all = profiles.filter((p) => p.agent === agentId);
  const derived = provider?.startsWith("ccode-") ? provider.slice("ccode-".length) : null;
  const byGateway =
    derived
      ? all.filter((p) => {
          const hex = (p.gatewayId ?? "").replace(/-/g, "");
          return hex.startsWith(derived);
        })
      : [];
  const compat = derived
    ? byGateway.length > 0
      ? byGateway
      : all.filter((p) => p.baseUrl?.trim())
    : provider === "ccode"
      ? all.filter((p) => p.baseUrl?.trim())
      : all;
  const pool = compat.length > 0 ? compat : all;
  const visible = pool.filter((p) => !(hiddenIds ?? []).includes(p.id));
  const finalPool = visible.length > 0 ? visible : pool;
  return finalPool.find((p) => p.id === wishedId) ?? finalPool[0] ?? null;
}
