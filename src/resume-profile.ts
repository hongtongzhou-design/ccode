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
 */
export function pickResumeProfile<
  T extends { id: string; agent: string; baseUrl: string | null },
>(
  profiles: T[],
  agentId: string,
  provider: string | null | undefined,
  wishedId: string | null | undefined,
): T | null {
  const all = profiles.filter((p) => p.agent === agentId);
  const compat =
    provider === "ccode" ? all.filter((p) => p.baseUrl?.trim()) : all;
  const pool = compat.length > 0 ? compat : all;
  return pool.find((p) => p.id === wishedId) ?? pool[0] ?? null;
}
