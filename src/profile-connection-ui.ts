/** 连接行状态文案与「同步目录」是否出现。 */

export const CONNECTION_STATUS_CAPTION: Record<
  string,
  [text: string, tip: string, cls: string]
> = {
  gateway_missing: ["网关缺失", "绑定的网关已不存在", "text-err-text"],
  slot_missing: ["缺槽", "这个网关还没配该协议的端点", "text-warn-text"],
  credential_missing: [
    "缺密钥",
    "网关未配置密钥且不是无密钥端点",
    "text-warn-text",
  ],
  untested: ["未测试", "尚未完成该协议槽的连接测试", "text-l4"],
  probe_failed: ["测试失败", "最近一次连接测试失败，请重新测试", "text-err-text"],
  catalog_stale: ["目录过期", "模型目录超过 7 天未刷新", "text-warn-text"],
  model_unsynced: [
    "模型未同步",
    "绑定模型与网关目录不同步",
    "text-warn-text",
  ],
  ready: ["已连接", "最近一次连接测试通过", "text-ok-text"],
  official: ["官方账号", "由 CLI 官方登录态提供", "text-ok-text"],
};

export function profileConnectionCaptions(profile: {
  connectionStatus?: string;
  modelSyncStatus?: string;
  modelSyncNote?: string | null;
}): { text: string; tip: string; cls: string }[] {
  const parts: { text: string; tip: string; cls: string }[] = [];
  const status = profile.connectionStatus;
  if (status && status !== "ready" && status !== "official") {
    if (status === "model_unsynced") {
      const note = profile.modelSyncNote?.trim();
      parts.push({
        text: note || "模型未同步",
        tip: note || CONNECTION_STATUS_CAPTION.model_unsynced[1],
        cls: "text-warn-text",
      });
      return parts;
    }
    const lab = CONNECTION_STATUS_CAPTION[status];
    if (lab) parts.push({ text: lab[0], tip: lab[1], cls: lab[2] });
  }
  if (profile.modelSyncStatus === "stale" || profile.modelSyncStatus === "missing") {
    parts.push({
      text: profile.modelSyncStatus === "missing" ? "绑定模型失效" : "目录模型失效",
      tip: profile.modelSyncNote ?? "绑定模型与网关目录未同步",
      cls: "text-warn-text",
    });
  }
  return parts;
}

/** 「同步目录」只处理目录过期。绑定模型不在目录 / 已标失效，刷新目录清不掉，应去编辑勾选。 */
export function showCatalogSyncAction(profile: {
  accountType?: string;
  gatewayId?: string | null;
  connectionStatus?: string;
}): boolean {
  return (
    profile.accountType !== "official" &&
    Boolean(profile.gatewayId) &&
    profile.connectionStatus === "catalog_stale"
  );
}
