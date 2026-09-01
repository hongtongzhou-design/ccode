import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { Checkbox, fieldClass, FoldMark, primaryActionClass, secondaryActionClass } from "./PageFrame";
import { confirmDialog } from "./ConfirmDialog";
import { policyFieldHint, policyFieldMode } from "../combo-field";
import type {
  BindingInput,
  ComboSurfaceDto,
  Gateway,
  GatewayInput,
  GatewayModel,
  GatewayProbeDto,
  GatewayUsageRow,
  ModelCapabilityDto,
  ProtocolSlots,
  SlotProbeSummary,
} from "../types";

const SLOT_LABELS: { key: keyof ProtocolSlots; label: string }[] = [
  { key: "anthropic", label: "Anthropic" },
  { key: "openai", label: "OpenAI 兼容" },
  { key: "responses", label: "Responses（Codex）" },
  { key: "gemini", label: "Gemini" },
  { key: "cursor", label: "Cursor" },
];

function emptySlots(): ProtocolSlots {
  return { anthropic: "", openai: "", responses: "", gemini: "", cursor: "" };
}

function numOrNull(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function probeSummaryText(sum: SlotProbeSummary | undefined): string {
  if (!sum || sum.lastOk == null) return "— 未测";
  if (sum.lastOk) {
    return sum.lastLatencyMs != null ? `✓ ${sum.lastLatencyMs}ms` : "✓";
  }
  return "✗ 失败";
}

function catalogAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 16).replace("T", " ");
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (days === 0) return "今天获取";
  if (days === 1) return "1 天前获取";
  return `${days} 天前获取`;
}

export default function GatewayLibrary({
  onClose,
  onJumpUsage,
  initialId,
}: {
  onClose: () => void;
  onJumpUsage?: (gatewayId: string) => void;
  initialId?: string | null;
}) {
  const gateways = useAppStore((s) => s.gateways);
  const profiles = useAppStore((s) => s.profiles);
  const loadGateways = useAppStore((s) => s.loadGateways);
  const saveGateway = useAppStore((s) => s.saveGateway);
  const removeGateway = useAppStore((s) => s.removeGateway);
  const bindGateway = useAppStore((s) => s.bindGateway);
  const [editing, setEditing] = useState<Gateway | "new" | null>(null);
  const [name, setName] = useState("");
  const [noAuth, setNoAuth] = useState(false);
  const [slots, setSlots] = useState<ProtocolSlots>(emptySlots());
  // Base URL 主输入：中转站九成情况五个协议槽同址。值为空的槽与「仍等于旧主值」的槽
  // 跟随主输入；手动改过的槽脱离跟随（镜像到改写为止的经典交互）
  const [masterUrl, setMasterUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [comboByModel, setComboByModel] = useState<Record<string, ComboSurfaceDto>>({});
  const [caps, setCaps] = useState<Record<string, ModelCapabilityDto>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const [probingSlot, setProbingSlot] = useState<string | null>(null);
  const [probingAll, setProbingAll] = useState(false);
  const [bindAgent, setBindAgent] = useState("");
  const [monthUsage, setMonthUsage] = useState<GatewayUsageRow[]>([]);

  useEffect(() => {
    void loadGateways();
    invoke<GatewayUsageRow[]>("usage_by_gateway", { range: "month" })
      .then(setMonthUsage)
      .catch(() => setMonthUsage([]));
  }, [loadGateways]);

  const openedInitial = useRef(false);
  useEffect(() => {
    if (!initialId || openedInitial.current) return;
    const g = gateways.find((x) => x.id === initialId);
    if (g) {
      openedInitial.current = true;
      openEdit(g);
    }
  }, [initialId, gateways]);

  const rate = useAppStore((s) => s.settings?.rateUsdCny) ?? 7.2;

  function openEdit(g: Gateway | "new") {
    setError(null);
    setExpanded(null);
    setComboByModel({});
    if (g === "new") {
      setEditing("new");
      setName("");
      setNoAuth(false);
      setSlots(emptySlots());
      setMasterUrl("");
      setApiKey("");
      setHeaderText("");
      setModels([]);
      return;
    }
    setEditing(g);
    setName(g.name);
    setNoAuth(g.noAuth);
    const next = {
      anthropic: g.slots.anthropic ?? "",
      openai: g.slots.openai ?? "",
      responses: g.slots.responses ?? "",
      gemini: g.slots.gemini ?? "",
      cursor: g.slots.cursor ?? "",
    };
    setSlots(next);
    // 主输入初值：所有已填槽同址时取该址（跟随关系天然成立），混址时留空不强猜
    const filled = Object.values(next).filter((v) => v.trim());
    setMasterUrl(filled.length > 0 && filled.every((v) => v.trim() === filled[0].trim()) ? filled[0] : "");
    setApiKey("");
    setHeaderText(
      Object.entries(g.headerEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    setModels(g.models.map((m) => ({ ...m })));
  }

  /** 主输入变更：空槽与跟随中的槽（仍等于旧主值）一起改，手动改过的槽不动 */
  function onMasterChange(v: string) {
    const prev = masterUrl;
    setMasterUrl(v);
    setSlots((s) => {
      const out = { ...s };
      for (const { key } of SLOT_LABELS) {
        const cur = (s[key] ?? "").trim();
        if (cur === "" || cur === prev.trim()) out[key] = v;
      }
      return out;
    });
  }

  useEffect(() => {
    if (editing === null || editing === "new") return;
    let cancelled = false;
    for (const m of models) {
      void invoke<ComboSurfaceDto>("combo_surface_for_gateway", {
        gatewayId: editing.id,
        model: m.id,
      })
        .then((c) => {
          if (!cancelled) setComboByModel((cur) => ({ ...cur, [m.id]: c }));
        })
        .catch(() => {});
      void invoke<ModelCapabilityDto>("model_capability_brief", {
        gatewayId: editing.id,
        modelId: m.id,
      })
        .then((c) => {
          if (!cancelled) setCaps((cur) => ({ ...cur, [m.id]: c }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [editing, models]);

  function patchModel(id: string, patch: Partial<GatewayModel>) {
    setModels((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function slotSum(key: keyof ProtocolSlots): SlotProbeSummary | undefined {
    if (editing === null || editing === "new") return undefined;
    return (editing.slotProbes ?? []).find((s) => s.slot === key);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const headerEnv: Record<string, string> = {};
    for (const line of headerText.split("\n")) {
      const i = line.indexOf("=");
      if (i <= 0) continue;
      headerEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const input: GatewayInput = {
      name: name.trim() || "未命名网关",
      noAuth,
      slots: {
        anthropic: slots.anthropic?.trim() || null,
        openai: slots.openai?.trim() || null,
        responses: slots.responses?.trim() || null,
        gemini: slots.gemini?.trim() || null,
        cursor: slots.cursor?.trim() || null,
      },
      headerEnv,
      models,
      apiKey: apiKey.trim() || null,
    };
    const id = editing === "new" || editing === null ? null : editing.id;
    try {
      await saveGateway(id, input);
      const list = useAppStore.getState().gateways;
      const saved = id ? list.find((g) => g.id === id) : list[list.length - 1];
      if (saved) setEditing(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function onClearKey() {
    if (editing === null || editing === "new") return;
    const n = profiles.filter((p) => p.gatewayId === editing.id).length;
    const extra = n > 1 ? `共用这个网关的 ${n} 个 Agent 都会没密钥。` : "";
    if (
      !(await confirmDialog(`清除「${editing.name}」的本地密钥？${extra}`, { danger: true }))
    )
      return;
    try {
      await invoke("clear_gateway_key", { id: editing.id });
      await loadGateways();
      const list = await invoke<Gateway[]>("list_gateways");
      const fresh = list.find((g) => g.id === editing.id);
      if (fresh) setEditing(fresh);
      setApiKey("");
      setNotice("已清除本地密钥");
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(g: Gateway) {
    const bound = profiles.filter((p) => p.gatewayId === g.id);
    if (bound.length) {
      setError(`还有 Agent 绑着「${g.name}」，请先解绑`);
      return;
    }
    if (!(await confirmDialog(`删除网关「${g.name}」？密钥一并删除。`, { danger: true })))
      return;
    try {
      await removeGateway(g.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function undoMerge() {
    try {
      const n = await invoke<number>("unbind_split_merge");
      setNotice(n ? `已拆开 ${n} 条被合并的绑定` : "没有可拆开的自动合并");
      await loadGateways();
      await useAppStore.getState().loadAll();
    } catch (e) {
      setError(String(e));
    }
  }

  async function fetchCatalog() {
    if (editing === null || editing === "new") return;
    setFetchingCatalog(true);
    setError(null);
    try {
      const saved = await invoke<Gateway>("fetch_gateway_catalog", { gatewayId: editing.id });
      const list = await invoke<Gateway[]>("list_gateways");
      const fresh = list.find((g) => g.id === saved.id) ?? saved;
      setModels(fresh.models.map((m) => ({ ...m })));
      setEditing(fresh);
      setNotice(
        `已获取模型目录${saved.catalogFromSlot ? `（${saved.catalogFromSlot} 槽）` : ""}`,
      );
      await loadGateways();
    } catch (e) {
      setError(String(e));
    } finally {
      setFetchingCatalog(false);
    }
  }

  async function probeOne(slot: keyof ProtocolSlots, basicOnly: boolean) {
    if (editing === null || editing === "new") return;
    if (slot === "cursor" || slot === "gemini") {
      setError(slot === "cursor" ? "Cursor 为专有协议，不支持网关体检" : "Gemini 协议暂不支持网关体检");
      return;
    }
    if (!slots[slot]?.trim()) {
      setError("这个槽还没填端点");
      return;
    }
    if ((slots[slot] ?? "").trim() !== (editing.slots[slot] ?? "").trim()) {
      setError("请先保存端点再测试，测的是已保存的地址");
      return;
    }
    setProbingSlot(slot);
    setError(null);
    try {
      await invoke<GatewayProbeDto>("probe_gateway_slot", {
        gatewayId: editing.id,
        slot,
        model: null,
        basicOnly,
      });
      const list = await invoke<Gateway[]>("list_gateways");
      const fresh = list.find((g) => g.id === editing.id);
      if (fresh) setEditing(fresh);
      await loadGateways();
    } catch (e) {
      setError(String(e));
    } finally {
      setProbingSlot(null);
    }
  }

  async function probeAll() {
    if (editing === null || editing === "new") return;
    const dirty = SLOT_LABELS.some(
      (s) => (slots[s.key] ?? "").trim() !== (editing.slots[s.key] ?? "").trim(),
    );
    if (dirty) {
      setError("请先保存端点再测速，测的是已保存的地址");
      return;
    }
    const gatewayId = editing.id;
    setProbingAll(true);
    setError(null);
    const filled = SLOT_LABELS.map((s) => s.key).filter(
      (k) => slots[k]?.trim() && k !== "cursor" && k !== "gemini",
    );
    // 按 URL 去重：同址槽只探一次（体检结果只取决于地址+密钥），探完把摘要镜像给同址槽
    const byUrl = new Map<string, (keyof ProtocolSlots)[]>();
    for (const k of filled) {
      const u = slots[k]!.trim();
      const group = byUrl.get(u) ?? [];
      group.push(k);
      byUrl.set(u, group);
    }
    for (const group of byUrl.values()) {
      try {
        await invoke<GatewayProbeDto>("probe_gateway_slot", {
          gatewayId,
          slot: group[0],
          model: null,
          basicOnly: true,
        });
      } catch (e) {
        setError(String(e));
      }
    }
    const list = await invoke<Gateway[]>("list_gateways");
    const fresh = list.find((g) => g.id === gatewayId);
    if (fresh) {
      // 同址槽的后端摘要在保存前不会逐槽刷新——同址同结果，前端镜像一份展示
      const probes = (fresh.slotProbes ??= []);
      for (const group of byUrl.values()) {
        if (group.length < 2) continue;
        const src = probes.find((s) => s.slot === group[0]);
        if (!src) continue;
        for (const k of group.slice(1)) {
          const i = probes.findIndex((s) => s.slot === k);
          if (i >= 0) probes[i] = { ...src, slot: k };
          else probes.push({ ...src, slot: k });
        }
      }
      setEditing(fresh);
    }
    await loadGateways();
    setProbingAll(false);
  }

  async function bindToAgent() {
    if (editing === null || editing === "new" || !bindAgent) return;
    const input: BindingInput = {
      agent: bindAgent,
      gatewayId: editing.id,
      kind: "api",
      protocol: null,
      models: models.map((m) => m.id),
      extraEnv: {},
    };
    try {
      await bindGateway(input);
      setNotice(`已绑定到 ${AGENTS.find((a) => a.id === bindAgent)?.label ?? bindAgent}`);
      setBindAgent("");
      await useAppStore.getState().loadAll();
    } catch (e) {
      setError(String(e));
    }
  }

  const boundAgents = useMemo(() => {
    if (editing === null || editing === "new") return [];
    return profiles.filter((p) => p.gatewayId === editing.id);
  }, [editing, profiles]);

  const unboundAgents = AGENTS.filter(
    (a) => !boundAgents.some((p) => p.agent === a.id),
  );

  function usageLine(g: Gateway): string | null {
    const row = monthUsage.find((r) => r.bucket === "gateway" && r.gatewayId === g.id);
    if (!row) return null;
    const yen =
      row.costUsd != null ? `¥${(row.costUsd * rate).toFixed(1)}` : "~";
    return `近 30 天 ${yen} · ${row.sessionCount} 会话`;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-hairline bg-canvas p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium text-l1">网关库</h2>
          <div className="flex gap-2">
            <button type="button" className={secondaryActionClass} onClick={() => void undoMerge()}>
              拆开自动合并
            </button>
            <button type="button" className={primaryActionClass} onClick={() => openEdit("new")}>
              + 新建网关
            </button>
            <button type="button" className={secondaryActionClass} onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        {error && <p className="mb-2 text-sm text-err-text">{error}</p>}
        {notice && <p className="mb-2 text-sm text-ok-text">{notice}</p>}
        {editing ? (
          <div className="space-y-2">
            <label className="block text-sm text-l2">
              名称
              <input className={`${fieldClass} mt-1 w-full`} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <Checkbox
              className="text-sm text-l2"
              checked={noAuth}
              onChange={setNoAuth}
              label="无密钥（本地端点）"
            />
            {editing !== "new" && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={secondaryActionClass}
                  disabled={fetchingCatalog}
                  onClick={() => void fetchCatalog()}
                >
                  {fetchingCatalog ? "获取中…" : "获取模型"}
                </button>
                <button
                  type="button"
                  className={secondaryActionClass}
                  disabled={probingAll}
                  onClick={() => void probeAll()}
                >
                  {probingAll ? "测速中…" : "全部测速"}
                </button>
                {catalogAge(editing.catalogFetchedAt) && (
                  <span className="self-center text-micro text-l4">
                    {catalogAge(editing.catalogFetchedAt)}
                    {editing.catalogFromSlot ? ` · ${editing.catalogFromSlot}` : ""}
                  </span>
                )}
              </div>
            )}
            <label className="block text-sm text-l2">
              <span className="flex items-center justify-between gap-2">
                <span>Base URL</span>
                <span className="text-micro text-l4">主输入：空槽与跟随中的槽一起改</span>
              </span>
              <input
                className={`${fieldClass} mt-1 w-full font-mono text-xs`}
                value={masterUrl}
                placeholder="https://…（五个协议槽同址时只填这里）"
                onChange={(e) => onMasterChange(e.target.value)}
              />
            </label>
            {SLOT_LABELS.map(({ key, label }) => {
              const follows =
                !slots[key]?.trim() && !!masterUrl.trim();
              return (
              <div key={key} className="space-y-1">
                <label className="block text-sm text-l2">
                  <span className="flex items-center justify-between gap-2">
                    <span>
                      {label}
                      {follows && (
                        <span className="ml-1.5 text-micro text-l4">跟随 Base URL</span>
                      )}
                    </span>
                    {editing !== "new" && (
                      <span className="font-mono text-micro text-l4">{probeSummaryText(slotSum(key))}</span>
                    )}
                  </span>
                  <input
                    className={`${fieldClass} mt-1 w-full font-mono text-xs`}
                    value={slots[key] ?? ""}
                    placeholder={follows ? masterUrl : "https://…"}
                    title={follows ? "留空 = 跟随 Base URL；填入即脱离跟随" : undefined}
                    onChange={(e) => setSlots((s) => ({ ...s, [key]: e.target.value }))}
                  />
                </label>
                {editing !== "new" && slots[key]?.trim() && key !== "cursor" && key !== "gemini" && (
                  <button
                    type="button"
                    className={secondaryActionClass}
                    disabled={
                      !!probingSlot ||
                      (slots[key] ?? "").trim() !== (editing.slots[key] ?? "").trim()
                    }
                    title={
                      (slots[key] ?? "").trim() !== (editing.slots[key] ?? "").trim()
                        ? "请先保存端点再测试"
                        : undefined
                    }
                    onClick={() => void probeOne(key, false)}
                  >
                    {probingSlot === key ? "测试中…" : "测试"}
                  </button>
                )}
              </div>
              );
            })}
            <label className="block text-sm text-l2">
              密钥（留空不改）
              <input
                className={`${fieldClass} mt-1 w-full`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            {editing !== "new" && editing.keyHint && (
              <button
                type="button"
                className={`${secondaryActionClass} text-err-text`}
                onClick={() => void onClearKey()}
              >
                清除本地密钥
              </button>
            )}
            <label className="block text-sm text-l2">
              Header（名=环境变量名，每行一条）
              <textarea
                className={`${fieldClass} mt-1 h-20 w-full font-mono text-xs`}
                value={headerText}
                onChange={(e) => setHeaderText(e.target.value)}
              />
            </label>
            {editing !== "new" && (
              <div className="rounded-md border border-hairline p-2 text-sm">
                <p className="mb-1 text-xs font-medium text-l2">绑定到 Agent</p>
                <ul className="mb-2 text-micro text-l3">
                  {boundAgents.length === 0 && <li>还没有 Agent 绑定</li>}
                  {boundAgents.map((p) => (
                    <li key={p.id}>
                      {AGENTS.find((a) => a.id === p.agent)?.label ?? p.agent}
                    </li>
                  ))}
                </ul>
                {unboundAgents.length > 0 && (
                  <div className="flex gap-2">
                    <select
                      className={fieldClass}
                      value={bindAgent}
                      onChange={(e) => setBindAgent(e.target.value)}
                    >
                      <option value="">选择 Agent…</option>
                      {unboundAgents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                    <button type="button" className={secondaryActionClass} onClick={() => void bindToAgent()}>
                      绑定
                    </button>
                  </div>
                )}
              </div>
            )}
            {models.length > 0 && (
              <div className="text-sm text-l2">
                模型策略（点行展开）
                <ul className="mt-1 divide-y divide-hairline">
                  {models.map((m) => {
                    const combo = comboByModel[m.id];
                    const cap = caps[m.id];
                    const open = expanded === m.id;
                    const effortMode = policyFieldMode({
                      capable: combo?.thinking ?? cap?.thinking ?? false,
                      injectAllowed: combo?.injectEffortAllowed ?? false,
                      channel: combo?.channelEffort,
                      probeFailed: combo?.probeEffort === "failed",
                      stored: m.reasoningEffort != null,
                    });
                    const tempMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectTemperatureAllowed ?? false,
                      channel: combo?.channelTemperature,
                      probeFailed: combo?.probeTemperature === "failed",
                      stored: m.temperature != null,
                    });
                    const topPMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectTopPAllowed ?? false,
                      channel: combo?.channelTopP,
                      probeFailed: combo?.probeTemperature === "failed",
                      stored: m.topP != null,
                    });
                    const maxMode = policyFieldMode({
                      capable: true,
                      injectAllowed: combo?.injectMaxTokensAllowed ?? false,
                      channel: combo?.channelMaxTokens,
                      probeFailed: false,
                      stored: m.maxOutputTokens != null,
                    });
                    return (
                      <li key={m.id} className="py-1">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 text-left font-mono text-xs"
                          onClick={() => setExpanded(open ? null : m.id)}
                        >
                          <FoldMark open={open} />
                          <span className="min-w-0 flex-1 truncate">{m.id}</span>
                          <span className="text-micro text-l4">
                            {(cap ?? combo)?.thinking ? "思考" : ""}
                            {(cap ?? combo)?.vision ? " 视觉" : ""}
                            {cap?.context ? ` ${Math.round(cap.context / 1024)}K` : ""}
                          </span>
                        </button>
                        {open && (
                          <div className="mt-1 space-y-1 pl-5">
                            {combo?.probeNote && (
                              <p className="text-[11px] text-warn-text">{combo.probeNote}</p>
                            )}
                            {combo?.policyChannelNote && (
                              <p className="text-[11px] text-l4">{combo.policyChannelNote}</p>
                            )}
                            {effortMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                思考档
                                {effortMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: combo?.thinking ?? cap?.thinking ?? false,
                                    injectAllowed: combo?.injectEffortAllowed ?? false,
                                    channel: combo?.channelEffort,
                                    probeFailed: combo?.probeEffort === "failed",
                                    stored: m.reasoningEffort != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  disabled={effortMode === "readonly"}
                                  placeholder="low / medium / high"
                                  value={m.reasoningEffort ?? ""}
                                  onChange={(e) =>
                                    patchModel(m.id, { reasoningEffort: e.target.value || null })
                                  }
                                />
                              </label>
                            )}
                            {tempMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                temperature
                                {tempMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectTemperatureAllowed ?? false,
                                    channel: combo?.channelTemperature,
                                    probeFailed: combo?.probeTemperature === "failed",
                                    stored: m.temperature != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={tempMode === "readonly"}
                                  step="0.1"
                                  min="0"
                                  max="2"
                                  value={m.temperature ?? ""}
                                  onChange={(e) =>
                                    patchModel(m.id, { temperature: numOrNull(e.target.value) })
                                  }
                                />
                              </label>
                            )}
                            {topPMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                top_p
                                {topPMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectTopPAllowed ?? false,
                                    channel: combo?.channelTopP,
                                    probeFailed: combo?.probeTemperature === "failed",
                                    stored: m.topP != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={topPMode === "readonly"}
                                  step="0.05"
                                  min="0"
                                  max="1"
                                  value={m.topP ?? ""}
                                  onChange={(e) => patchModel(m.id, { topP: numOrNull(e.target.value) })}
                                />
                              </label>
                            )}
                            {maxMode !== "hidden" && (
                              <label className="block text-micro text-l3">
                                max output
                                {maxMode === "readonly" && (
                                  <span className="ml-1 text-l4">{policyFieldHint({
                                    capable: true,
                                    injectAllowed: combo?.injectMaxTokensAllowed ?? false,
                                    channel: combo?.channelMaxTokens,
                                    probeFailed: false,
                                    stored: m.maxOutputTokens != null,
                                  })}</span>
                                )}
                                <input
                                  className={`${fieldClass} mt-0.5 w-full`}
                                  type="number"
                                  disabled={maxMode === "readonly"}
                                  min="1"
                                  value={m.maxOutputTokens ?? ""}
                                  onChange={(e) =>
                                    patchModel(m.id, {
                                      maxOutputTokens: numOrNull(e.target.value),
                                    })
                                  }
                                />
                              </label>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button type="button" className={primaryActionClass} disabled={saving} onClick={() => void save()}>
                保存
              </button>
              <button type="button" className={secondaryActionClass} onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-hairline">
            {gateways.length === 0 && <li className="py-6 text-center text-sm text-l3">还没有网关</li>}
            {gateways.map((g) => {
              const n = profiles.filter((p) => p.gatewayId === g.id).length;
              const filled = SLOT_LABELS.filter(({ key }) => g.slots[key]).map((s) => s.label);
              const usage = usageLine(g);
              return (
                <li key={g.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-l1">{g.name}</span>
                    <span className="ml-2 text-l3">
                      {n} 个绑定
                      {filled.length ? ` · ${filled.join("、")}` : " · 未填槽"}
                      {g.keyHint ? ` · ${g.keyHint}` : ""}
                    </span>
                    {usage && (
                      <button
                        type="button"
                        className="mt-0.5 block text-micro text-l4 hover:text-l2"
                        onClick={() => onJumpUsage?.(g.id)}
                      >
                        {usage}
                      </button>
                    )}
                  </span>
                  <button type="button" className={secondaryActionClass} onClick={() => openEdit(g)}>
                    编辑
                  </button>
                  <button type="button" className={secondaryActionClass} onClick={() => void onDelete(g)}>
                    删除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
