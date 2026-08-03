import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS } from "../types";
import { PRESETS } from "../presets";
import ContextMenu from "../components/ContextMenu";
import { PageFrame, PageHeader, primaryActionClass } from "../components/PageFrame";
import type { Profile, ProfileInput, ProfileUsageDto } from "../types";

function ProfileModal({
  initial,
  presetAgent,
  onClose,
}: {
  initial: Profile | null;
  /** 从某个 agent 组的「+ 添加配置」打开时预选该 agent */
  presetAgent?: string;
  onClose: () => void;
}) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const [form, setForm] = useState({
    agent: initial?.agent ?? presetAgent ?? "claude-code",
    name: initial?.name ?? "",
    protocol: (initial?.protocol ??
      AGENT_PROTOCOLS[initial?.agent ?? "claude-code"]?.default ??
      null) as string | null,
    baseUrl: initial?.baseUrl ?? "",
    models: initial?.models ?? ([] as string[]),
    extraEnvText: Object.entries(initial?.extraEnv ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    apiKey: "",
  });
  const [modelInput, setModelInput] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 解析「每行 KEY=VALUE」文本为环境变量表，# 开头视为注释 */
  function parseEnvLines(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  function addModel() {
    const m = modelInput.trim();
    if (m && !form.models.includes(m)) {
      setForm({ ...form, models: [...form.models, m] });
    }
    setModelInput("");
  }

  /** 验证端点+密钥连通性，显示延迟与模型数 */
  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    const started = Date.now();
    try {
      const list = await invoke<string[]>("fetch_models", {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey || null,
        profileId: initial?.id ?? null,
      });
      setTestResult({
        ok: true,
        text: `✓ 连通 · ${list.length} 个模型 · ${Date.now() - started}ms`,
      });
    } catch (e) {
      setTestResult({ ok: false, text: `✗ ${String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  /** 从 Base URL 拉取模型列表；密钥用表单新填的，编辑时留空则用钥匙串已存的 */
  async function fetchModels() {
    setFetching(true);
    setFetchError(null);
    try {
      const list = await invoke<string[]>("fetch_models", {
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey || null,
        profileId: initial?.id ?? null,
      });
      setFetchedModels(list);
    } catch (e) {
      setFetchError(String(e));
      setFetchedModels(null);
    } finally {
      setFetching(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const input: ProfileInput = {
      agent: form.agent,
      name: form.name.trim(),
      protocol: AGENT_PROTOCOLS[form.agent] ? form.protocol : null,
      baseUrl: form.baseUrl.trim(),
      models: form.models,
      extraEnv: parseEnvLines(form.extraEnvText),
      apiKey: form.apiKey || null,
    };
    try {
      await saveProfile(initial?.id ?? null, input);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const field =
    "w-full rounded border border-field bg-canvas px-2 py-1.5 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="max-h-[90vh] w-[36rem] overflow-y-auto rounded-md border border-field bg-strip p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">
          {initial ? "编辑配置" : "新建配置"}
        </h2>
        <div className="mb-4 grid grid-cols-2 items-end gap-3">
          <select
            className={field}
            value=""
            onChange={(e) => {
              const preset = PRESETS.find(
                (p) => p.agent === form.agent && p.name === e.target.value,
              );
              if (preset) {
                setForm({
                  ...form,
                  baseUrl: preset.baseUrl,
                  name: form.name || preset.name,
                  protocol: preset.protocol ?? form.protocol,
                });
              }
            }}
          >
            <option value="" disabled>
              从预设快速填充（可选）…
            </option>
            {PRESETS.filter((p) => p.agent === form.agent).map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.note ? `（${p.note}）` : ""}
              </option>
            ))}
          </select>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-l3">Agent</span>
            <select
              className={field}
              value={form.agent}
              onChange={(e) =>
                setForm({
                  ...form,
                  agent: e.target.value,
                  protocol: AGENT_PROTOCOLS[e.target.value]?.default ?? null,
                })
              }
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">名称</span>
          <input
            className={field}
            required
            placeholder="官方 / 中转 A"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">Base URL（可选）</span>
          <div className="flex gap-2">
            <input
              className={field}
              placeholder="https://api.example.com"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
            <button
              type="button"
              onClick={testConnection}
              disabled={testing || !form.baseUrl.trim()}
              title={form.baseUrl.trim() ? "验证端点与密钥连通性" : "先填写 Base URL"}
              className="w-20 shrink-0 rounded bg-btn px-2 py-1 text-xs text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
        </label>
        {testResult && (
          <p className={`-mt-2 mb-3 text-xs ${testResult.ok ? "text-ok-text" : "text-err-text"}`}>
            {testResult.text}
          </p>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">API Key</span>
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            placeholder={initial ? "留空则不修改" : "存入本地受限文件（0600），不回显"}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
        <div className="mb-4 text-sm">
          <span className="mb-1 block text-xs text-l3">
            模型列表（可选，首个为默认）
          </span>
          {(() => {
            const sw = MODEL_SWITCH[form.agent];
            if (!sw) return null;
            const over = sw.max != null && form.models.length > sw.max;
            return (
              <p
                title={sw.hint}
                className={`mb-2 text-xs ${over ? "text-warn-text" : "text-l3"}`}
              >
                {sw.max != null ? `最多 ${sw.max} 个模型可进入 CLI 选择器` : "模型数量不限"}
                {over && `；当前超出 ${form.models.length - (sw.max ?? 0)} 个`}
              </p>
            );
          })()}
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={fetchModels}
              disabled={fetching || !form.baseUrl.trim()}
              title={form.baseUrl.trim() ? "从 Base URL 拉取可用模型" : "先填写 Base URL"}
              className="shrink-0 rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              {fetching ? "获取中…" : "获取模型"}
            </button>
            {fetchedModels && fetchedModels.length > 0 && (
              <select
                className={field}
                value=""
                onChange={(e) => {
                  const m = e.target.value;
                  if (m && !form.models.includes(m)) {
                    setForm({ ...form, models: [...form.models, m] });
                  }
                }}
              >
                <option value="" disabled>
                  从 {fetchedModels.length} 个模型中选择…
                </option>
                {fetchedModels.map((m) => (
                  <option key={m} value={m}>
                    {form.models.includes(m) ? `${m}（已添加）` : m}
                  </option>
                ))}
              </select>
            )}
            {fetchedModels && fetchedModels.length === 0 && (
              <span className="text-xs text-l4">接口返回 0 个模型</span>
            )}
          </div>
          {fetchError && <p className="mb-2 text-xs text-err-text">{fetchError}</p>}
          {form.models.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.models.map((m, i) => (
                <span
                  key={m}
                  className="flex items-center gap-1 rounded bg-inset px-2 py-0.5 text-xs text-l2"
                >
                  {m}
                  {i === 0 && <span className="text-l1">默认</span>}
                  <button
                    type="button"
                    aria-label={`移除 ${m}`}
                    onClick={() =>
                      setForm({ ...form, models: form.models.filter((x) => x !== m) })
                    }
                    className="text-l4 hover:text-err-text"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className={field}
              placeholder="输入模型名后回车添加，如 claude-sonnet-4"
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addModel();
                }
              }}
            />
            <button
              type="button"
              onClick={addModel}
              disabled={!modelInput.trim()}
              className="shrink-0 rounded bg-btn px-3 py-1.5 text-sm text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              添加
            </button>
          </div>
        </div>
        <details className="mb-4 border-t border-hairline pt-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-l2">
            高级配置
          </summary>
          <div className="mt-3">
            {AGENT_PROTOCOLS[form.agent] && (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs text-l3">协议</span>
                <select
                  className={field}
                  value={form.protocol ?? AGENT_PROTOCOLS[form.agent].default}
                  onChange={(e) => setForm({ ...form, protocol: e.target.value })}
                >
                  {AGENT_PROTOCOLS[form.agent].options.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-l3">
                附加环境变量（每行 KEY=VALUE，可覆盖内置值）
              </span>
              <textarea
                className={`${field} h-20 font-mono text-xs`}
                placeholder={"HTTPS_PROXY=http://127.0.0.1:7890\nANTHROPIC_SMALL_FAST_MODEL=claude-haiku"}
                value={form.extraEnvText}
                onChange={(e) => setForm({ ...form, extraEnvText: e.target.value })}
              />
            </label>
          </div>
        </details>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-l2 hover:bg-white/5"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

/** 分组折叠状态持久化的 localStorage key：值为折叠中的 agent id 数组 */
const COLLAPSED_KEY = "ccode.profiles.collapsed";

/** 读取已持久化的折叠分组；无记录（首次使用）或数据损坏时返回空集（全部展开） */
function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

interface AgentCmdResult {
  ok: boolean;
  output: string;
  method: string;
  versionBefore: string | null;
  versionAfter: string | null;
}

/** 最新版检查结果（check_agent_updates）；latest 为 null 表示该渠道查不到 */
interface AgentUpdateInfo {
  id: string;
  installed: string | null;
  latest: string | null;
  outdated: boolean;
}

/** 各 agent 在 TUI 模型切换页可用的模型数上限（注入模式；matrix 调研结论）。
 *  max = null 表示不限（选择器列出全部已配置模型） */
const MODEL_SWITCH: Record<string, { max: number | null; hint: string }> = {
  "claude-code": {
    max: 5,
    hint: "前 4 个占 SONNET/OPUS/HAIKU/FABLE 别名槽，第 5 个占自定义槽；超出的只能 /model <id> 手输",
  },
  codex: { max: null, hint: "启动时生成模型 catalog，/model 选择器列出全部已配置模型" },
  gemini: { max: 1, hint: "CLI 无多模型注入机制，多模型只能在 TUI 里 /model set 手动切换" },
  qwen: { max: 1, hint: "多模型需「⋯ → 设为全局」写入配置后才能在 /model 里切换" },
  opencode: { max: null, hint: "全部已配置模型都会注册，可在 TUI 自由切换" },
  kimi: { max: 1, hint: "多模型需「⋯ → 设为全局」写入配置后才能在模型页切换" },
};

function relTime(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

function displayHost(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return "";
  try {
    return new URL(value).host || "自定义端点";
  } catch {
    const parts = value
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#\s]/)[0]
      .split("@");
    const authority = parts[parts.length - 1];
    return authority && /^[\w.:[\]-]+$/.test(authority) ? authority : "自定义端点";
  }
}

/** 失败诊断：按输出/方式文本给一条下一步建议，无匹配则不提示（纯函数，可单测） */
function diagnose(output: string, method: string): string | null {
  const lower = output.toLowerCase();
  if (
    method.includes("brew") &&
    (output.includes("formulae.brew.sh") || output.includes("Downloading"))
  ) {
    return "brew 元数据下载异常：先在系统终端跑 `brew doctor` 检查 brew 状态，或重试（会走 TUNA 镜像）";
  }
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    output.includes("Could not resolve") ||
    output.includes("Failed to connect")
  ) {
    return "网络连接问题：检查代理设置；如在国内网络，brew 已自动走 TUNA 镜像，npm 可配置 registry.npmmirror.com 镜像";
  }
  if (output.includes("EACCES") || lower.includes("permission denied")) {
    return "权限不足：该命令需要写入全局目录，检查安装目录权限";
  }
  if (output.includes("命令超时")) {
    return "命令超过 15 分钟未完成被终止：通常是下载过慢，重试或检查网络";
  }
  return null;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ProfilesPage() {
  const profiles = useAppStore((s) => s.profiles);
  const [usageMap, setUsageMap] = useState<Record<string, ProfileUsageDto>>({});
  const [usagePop, setUsagePop] = useState<{ x: number; y: number; id: string } | null>(null);

  // 各 profile 用量（按模型近似归属；模型跨 profile 共享时会重复计入）
  useEffect(() => {
    if (!profiles.length) return;
    Promise.all(
      profiles.map(async (p) => {
        try {
          return [p.id, await invoke<ProfileUsageDto>("profile_usage", { profileId: p.id })] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      const m: Record<string, ProfileUsageDto> = {};
      for (const e of entries) if (e) m[e[0]] = e[1];
      setUsageMap(m);
    });
  }, [profiles]);
  const agents = useAppStore((s) => s.agents);
  const removeProfile = useAppStore((s) => s.removeProfile);
  const duplicateProfile = useAppStore((s) => s.duplicateProfile);
  const loadAll = useAppStore((s) => s.loadAll);
  const [modal, setModal] = useState<{ initial: Profile | null; presetAgent?: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; profile: Profile } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 过滤条：按安装状态过滤 agent 组；按名称/端点/模型过滤配置行
  const [statusFilter, setStatusFilter] = useState<"all" | "installed" | "uninstalled">("all");
  const [search, setSearch] = useState("");
  // 组折叠状态：首次使用默认全部展开，手动折叠后持久化到 localStorage
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);

  /** 更新折叠集合并同步写入 localStorage */
  function updateCollapsed(updater: (prev: Set<string>) => Set<string>) {
    setCollapsedGroups((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用时静默降级为仅本次会话生效
      }
      return next;
    });
  }
  const [globalBackups, setGlobalBackups] = useState<Record<string, boolean>>({});
  // 各 agent 的升级/安装进行态、实时输出与最近结果（可并发操作多个 agent）
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [updateResults, setUpdateResults] = useState<Record<string, AgentCmdResult>>({});
  // 各 agent 最新版检查（组头「新版/已更新」状态；查不到渠道的组头回退普通「更新」按钮）
  const [updateInfo, setUpdateInfo] = useState<Record<string, AgentUpdateInfo>>({});

  async function refreshUpdateInfo() {
    try {
      const list = await invoke<AgentUpdateInfo[]>("check_agent_updates");
      setUpdateInfo(Object.fromEntries(list.map((i) => [i.id, i])));
    } catch {
      /* 检查失败（网络等）不影响页面 */
    }
  }
  // 挂载查一次；更新/安装跑完（后端缓存已失效）后重查
  useEffect(() => {
    void refreshUpdateInfo();
  }, [updateResults]);
  // 运行中 run 的交互输入（如回答 brew 的 [y/n]）
  const [cmdInput, setCmdInput] = useState<Record<string, string>>({});
  // 各 run 最近一次收到输出块的时间戳（ref 即可，渲染时按当前时间算闲置分钟数）
  const lastChunkAtRef = useRef<Record<string, number>>({});
  // 仅用于让闲置提醒每 15s 重算一次
  const [, setIdleTick] = useState(0);

  /** 向运行中的安装/更新进程写一行输入（Enter 发送，自动补 \n） */
  async function sendUpdaterInput(agentId: string) {
    const text = cmdInput[agentId] ?? "";
    if (!text) return;
    setCmdInput((prev) => ({ ...prev, [agentId]: "" }));
    try {
      await invoke("updater_write", { agentId, data: `${text}\n` });
    } catch (e) {
      setError(String(e));
    }
  }

  /** 跑更新/安装命令：先挂事件监听再 invoke；结果以 done 事件为准，invoke 返回值兜底 */
  async function runAgentCmd(agentId: string, command: "update_agent" | "install_agent") {
    setUpdating((prev) => ({ ...prev, [agentId]: true }));
    setLiveOutput((prev) => ({ ...prev, [agentId]: "" }));
    lastChunkAtRef.current[agentId] = Date.now();
    // 闲置提醒用的节拍器：每 15s 触发一次重渲染，run 结束即清
    const idleTimer = setInterval(() => setIdleTick((t) => t + 1), 15000);
    const unOut = await listen<string>(`agent-update-output-${agentId}`, (e) => {
      lastChunkAtRef.current[agentId] = Date.now();
      setLiveOutput((prev) => ({
        ...prev,
        [agentId]: (prev[agentId] ?? "") + e.payload,
      }));
    });
    let doneArrived = false;
    const unDone = await listen<AgentCmdResult>(`agent-update-done-${agentId}`, (e) => {
      doneArrived = true;
      setUpdateResults((prev) => ({ ...prev, [agentId]: e.payload }));
    });
    try {
      const res = await invoke<AgentCmdResult>(command, { agentId });
      if (!doneArrived) {
        setUpdateResults((prev) => ({ ...prev, [agentId]: res }));
      }
      await loadAll();
    } catch (e) {
      if (!doneArrived) {
        setUpdateResults((prev) => ({
          ...prev,
          [agentId]: {
            ok: false,
            output: String(e),
            method: "",
            versionBefore: null,
            versionAfter: null,
          },
        }));
      }
    } finally {
      clearInterval(idleTimer);
      unOut();
      unDone();
      setUpdating((prev) => ({ ...prev, [agentId]: false }));
    }
  }

  /** 升级某个 agent 的 CLI；完成后重新 detect 刷新版本号 */
  async function onUpdate(agentId: string) {
    await runAgentCmd(agentId, "update_agent");
  }

  /** 安装未装的 agent：先亮出将执行的命令，用户确认后才跑 */
  async function onInstall(agentId: string) {
    try {
      const method = await invoke<string | null>("install_method_preview", { agentId });
      if (!method) {
        setError("未找到可用的安装工具（brew / npm / uv / curl 都不在 PATH）");
        return;
      }
      if (
        !window.confirm(
          `将通过以下命令安装 ${labelOf(agentId)}：\n\n${method}\n\n继续？`,
        )
      )
        return;
    } catch (e) {
      setError(String(e));
      return;
    }
    await runAgentCmd(agentId, "install_agent");
  }

  const labelOf = (agentId: string) =>
    AGENTS.find((a) => a.id === agentId)?.label ?? agentId;

  /** 每个 agent 是否有可恢复的全局配置备份（控制「恢复备份」按钮显隐） */
  async function refreshGlobalBackups() {
    const entries = await Promise.all(
      AGENTS.map(
        async (a) =>
          [a.id, await invoke<boolean>("has_global_backup", { agent: a.id })] as const,
      ),
    );
    setGlobalBackups(Object.fromEntries(entries));
  }

  useEffect(() => {
    refreshGlobalBackups().catch(() => {});
  }, [profiles]);

  /** 把 profile 写入该 CLI 的全局配置文件（带备份），UI 明示影响范围 */
  async function onApplyGlobal(p: Profile) {
    if (
      !window.confirm(
        `将把该配置写入 ${labelOf(p.agent)} 的全局配置文件（影响其他终端里的使用），原文件会自动备份。继续？`,
      )
    )
      return;
    try {
      const files = await invoke<string[]>("apply_profile_global", { profileId: p.id });
      await refreshGlobalBackups();
      window.alert(`已写入全局配置：\n${files.join("\n")}`);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 恢复该 agent 最近一次的备份（每个目标文件取最新 .bak） */
  async function onRestoreBackup(agentId: string) {
    if (
      !window.confirm(
        `将恢复 ${labelOf(agentId)} 最近一次备份的全局配置文件，当前内容会被覆盖。继续？`,
      )
    )
      return;
    try {
      const files = await invoke<string[]>("restore_global_backup", { agent: agentId });
      await refreshGlobalBackups();
      window.alert(files.length ? `已恢复：\n${files.join("\n")}` : "没有可恢复的备份");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 导出为 JSON（不含密钥），路径由系统保存对话框给出 */
  async function onExport() {
    try {
      const path = await save({
        defaultPath: "ccode-profiles.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await invoke("export_profiles", { path });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 从 JSON 导入，跳过重复项；密钥不在文件里，需导入后补填 */
  async function onImport() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const added = await invoke<number>("import_profiles", { path });
      await loadAll();
      setError(null);
      window.alert(`已导入 ${added} 个配置（密钥需逐个补填）`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(p: Profile) {
    if (!window.confirm(`删除配置「${p.name}」？钥匙串中的密钥会一并删除。`)) return;
    try {
      await removeProfile(p.id);
    } catch (e) {
      setError(String(e));
    }
  }

  const q = search.trim().toLowerCase();
  const matchProfile = (p: Profile) =>
    !q ||
    [p.name, p.baseUrl ?? "", ...p.models].join("\n").toLowerCase().includes(q);
  // 跨配置共享的模型（>1 个 profile 配置了同名模型）——用量按模型近似归属会重复计入，行内可见标记
  const sharedModels = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of profiles)
      for (const m of p.models) count.set(m, (count.get(m) ?? 0) + 1);
    return new Set([...count].filter(([, n]) => n > 1).map(([m]) => m));
  }, [profiles]);
  const visibleAgents = AGENTS.filter((a) => {
    const installed = !!agents.find((x) => x.id === a.id)?.binaryPath;
    if (statusFilter === "installed") return installed;
    if (statusFilter === "uninstalled") return !installed;
    return true;
  });
  // 可见分组中存在展开项 → 按钮显示「全部折叠」，否则「全部展开」
  const anyExpanded = visibleAgents.some((a) => !collapsedGroups.has(a.id));

  return (
    <div className="min-h-full bg-pg">
      <PageFrame>
        {/* 命令栏：标题 + 元信息，右侧动作 */}
        <PageHeader
          title="配置中心"
          meta={`${profiles.length} 个配置 · ${new Set(profiles.map((p) => p.agent)).size} 个 agent`}
          actions={
            <>
            <button
              onClick={onImport}
              className="rounded px-2 py-1 text-sm text-pl2 hover:bg-white/5"
            >
              导入
            </button>
            <button
              onClick={onExport}
              className="rounded px-2 py-1 text-sm text-pl2 hover:bg-white/5"
            >
              导出
            </button>
            <button
              onClick={() => setModal({ initial: null })}
              className={primaryActionClass}
            >
              + 新建配置
            </button>
            </>
          }
        />

        {/* 过滤条：状态分段 + 搜索 */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1">
            {(
              [
                ["all", "全部"],
                ["installed", "已安装"],
                ["uninstalled", "未安装"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setStatusFilter(k)}
                className={`rounded px-2.5 py-1 text-xs ${
                  statusFilter === k
                    ? "bg-grp text-pl1"
                    : "text-pl2 hover:text-pl1"
                }`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={() =>
                updateCollapsed((prev) => {
                  const next = new Set(prev);
                  if (anyExpanded) {
                    for (const a of visibleAgents) next.add(a.id);
                  } else {
                    for (const a of visibleAgents) next.delete(a.id);
                  }
                  return next;
                })
              }
              className="ml-2 flex h-7 items-center rounded px-2 text-xs text-pl2 hover:bg-white/5 hover:text-pl1"
            >
              {anyExpanded ? "全部折叠" : "全部展开"}
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称 / 端点 / 模型"
            className="w-56 rounded border border-hl2 bg-pg px-2 py-1 text-xs text-pl2 outline-none placeholder:text-l4 focus:border-l4"
          />
        </div>

        {error && <p className="mt-4 text-sm text-err-text">{error}</p>}

        {/* agent 分组（可折叠） */}
        <div className="mt-5">
          {visibleAgents.map((agent) => {
            const det = agents.find((a) => a.id === agent.id);
            const list = profiles.filter((p) => p.agent === agent.id && matchProfile(p));
            if (q && list.length === 0) return null;
            const isCollapsed = collapsedGroups.has(agent.id);
            return (
              <section key={agent.id} className="mb-3">
                <div className="flex h-10 items-center gap-2 rounded-t bg-grp px-3">
                  <button
                    onClick={() =>
                      updateCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        return next;
                      })
                    }
                    aria-label={isCollapsed ? "展开" : "收起"}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-sm text-pl2 hover:bg-white/5 hover:text-pl1"
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <h2 className="text-sm font-medium text-pl1">{agent.label}</h2>
                  {/* 已安装只显示版本号；右侧三态：新版（可点更新）/ 已更新 / 更新（查不到最新版时的回退） */}
                  {det?.binaryPath ? (
                    <span className="text-xs text-pl2">{det.version ?? ""}</span>
                  ) : (
                    <span className="text-xs text-pl2">
                      未安装（{agent.binary} 不在 PATH）
                    </span>
                  )}
                  {det?.binaryPath ? (
                    (() => {
                      if (updating[agent.id])
                        return <span className="ml-auto text-xs text-pl2">更新中…</span>;
                      const info = updateInfo[agent.id];
                      if (updateResults[agent.id]?.ok || (info && !info.outdated && info.latest))
                        return null;
                      if (info?.outdated)
                        return (
                          <button
                            onClick={() => onUpdate(agent.id)}
                            title={`有新版本 ${info.latest ?? ""}，点击更新`}
                            className="ml-auto text-xs text-cta hover:brightness-125"
                          >
                            新版
                          </button>
                        );
                      return (
                        <button
                          onClick={() => onUpdate(agent.id)}
                          className="ml-auto text-xs text-pl2 hover:text-pl1"
                        >
                          更新
                        </button>
                      );
                    })()
                  ) : (
                    <button
                      onClick={() => onInstall(agent.id)}
                      disabled={updating[agent.id]}
                      className="ml-auto h-8 rounded border border-cta-bd bg-cta px-2.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
                    >
                      {updating[agent.id] ? "安装中…" : "安装"}
                    </button>
                  )}
                </div>

                {!isCollapsed && (
                  <>
                    {/* 安装/更新实时输出（全宽，行为不变） */}
                    {updating[agent.id] && (
                      <div className="mt-2">
                        <pre
                          // callback ref：每次渲染都把滚动条钉在底部，实现跟随输出自动滚动
                          ref={(el) => {
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                          className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-t border border-hl2 border-b-0 bg-pg p-2 font-mono text-xs text-pl2"
                        >
                          {liveOutput[agent.id] || "运行中，等待输出…"}
                        </pre>
                        {(() => {
                          // 120s 无新输出给提示；新块到达（时间戳刷新）或 run 结束（整块隐藏）自动消失
                          const last = lastChunkAtRef.current[agent.id];
                          const idleMin = last ? Math.floor((Date.now() - last) / 60000) : 0;
                          if (idleMin < 2) return null;
                          return (
                            <div className="bg-warn px-2 py-1 text-xs text-warn-text">
                              已 {idleMin} 分钟无新输出：可能是网络慢，或命令在等待输入（在下方输入行回答）。若持续异常可把当前内容发给开发者。
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-1.5 rounded-b border border-hl2 bg-pg px-2 py-1.5">
                          <span className="font-mono text-xs text-l4">&gt;</span>
                          <input
                            value={cmdInput[agent.id] ?? ""}
                            onChange={(e) =>
                              setCmdInput((prev) => ({ ...prev, [agent.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void sendUpdaterInput(agent.id);
                            }}
                            placeholder="需要交互时在此输入（如 y），Enter 发送"
                            className="flex-1 bg-transparent font-mono text-xs text-pl2 outline-none placeholder:text-l4"
                          />
                        </div>
                      </div>
                    )}
                    {updateResults[agent.id] && (
                      <div className="mt-2 rounded bg-strip p-2 text-xs text-l2">
                        <span
                          className={
                            updateResults[agent.id].ok ? "text-okb" : "text-err-text"
                          }
                        >
                          {updateResults[agent.id].ok ? "✓ 更新完成" : "✗ 更新失败"}
                        </span>
                        <span>
                          {updateResults[agent.id].method &&
                            `（${updateResults[agent.id].method}）`}
                          {updateResults[agent.id].versionAfter &&
                            `：${updateResults[agent.id].versionBefore ?? "?"} → ${updateResults[agent.id].versionAfter}`}
                        </span>
                        {updateResults[agent.id].output && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-l3">输出</summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                              {updateResults[agent.id].output}
                            </pre>
                          </details>
                        )}
                        {(() => {
                          const r = updateResults[agent.id];
                          const hint = r.ok ? null : diagnose(r.output, r.method);
                          return hint ? (
                            <p className="mt-1 text-xs text-l3">💡 建议：{hint}</p>
                          ) : null;
                        })()}
                      </div>
                    )}

                    {list.length === 0 ? (
                      <div className="flex h-12 items-center justify-between border-b border-hl2">
                        <span className="text-sm text-l4">暂无配置</span>
                        <button
                          onClick={() => setModal({ initial: null, presetAgent: agent.id })}
                          className="text-xs text-pl2 hover:text-pl1"
                        >
                          + 添加配置
                        </button>
                      </div>
                    ) : (
                      <ul className="divide-y divide-hl2 overflow-x-auto">
                        {list.map((p) => (
                          <li
                            key={p.id}
                            className="grid h-16 grid-cols-[130px_minmax(200px,1fr)_150px_112px] items-center gap-2 text-sm"
                          >
                            {/* 名称（+用量悬浮按钮）+ 上次使用 */}
                            <span className="flex h-full flex-col justify-center overflow-hidden">
                              <span className="flex items-center gap-1 overflow-hidden">
                                <span className="truncate font-medium text-pl1">{p.name}</span>
                                {usageMap[p.id] && usageMap[p.id]!.input > 0 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const r = e.currentTarget.getBoundingClientRect();
                                      setUsagePop({ x: r.left, y: r.bottom + 4, id: p.id });
                                    }}
                                    title={
                                      p.models.some((m) => sharedModels.has(m))
                                        ? "查看用量/费用（含共享模型——同一模型配置在多个 profile，用量会重复计入）"
                                        : "查看用量/费用"
                                    }
                                    className="shrink-0 text-xs text-l4 hover:text-pl1"
                                  >
                                    ▸用量
                                  </button>
                                )}
                              </span>
                              <span className="truncate text-xs text-l4">
                                {p.lastUsedAt ? `${relTime(p.lastUsedAt)}使用` : "从未使用"}
                              </span>
                            </span>
                            {/* 仅展示端点域名，不暴露路径或查询参数 */}
                            <span className="flex min-w-0 flex-col justify-center overflow-hidden">
                              {p.baseUrl && (
                                <span
                                  className="mb-1 truncate text-xs text-pl2"
                                  title={displayHost(p.baseUrl)}
                                >
                                  {displayHost(p.baseUrl)}
                                </span>
                              )}
                              <span className="flex flex-wrap items-center gap-1 overflow-hidden">
                                {p.models.slice(0, 4).map((m, i) => (
                                  <span
                                    key={m}
                                    className={`rounded-md px-1.5 py-0.5 text-xs ${
                                      i === 0
                                        ? "bg-grp text-pl1"
                                        : "text-pl2 opacity-70"
                                    }`}
                                  >
                                    {m}
                                  </span>
                                ))}
                                {p.models.length > 4 && (
                                  <span
                                    className="text-xs text-l4"
                                    title={p.models.join("\n")}
                                  >
                                    +{p.models.length - 4}
                                  </span>
                                )}
                              </span>
                            </span>
                            {/* 密钥状态 */}
                            <span
                              className={`text-xs ${p.hasKey ? "text-okb" : "text-pl2"}`}
                            >
                              {p.hasKey ? `已存密钥 ${p.keyHint ?? ""}` : "无密钥"}
                            </span>
                            {/* 操作 */}
                            <span className="flex items-center justify-end gap-2 whitespace-nowrap">
                              <button
                                onClick={() => setModal({ initial: p })}
                                className="h-8 text-xs text-pl2 hover:text-pl1"
                              >
                                编辑
                              </button>
                              <button
                                onClick={(e) => {
                                  const r = e.currentTarget.getBoundingClientRect();
                                  setRowMenu({ x: r.left, y: r.bottom + 4, profile: p });
                                }}
                                aria-label="更多操作"
                                className="h-8 rounded px-1 text-l4 hover:bg-white/5 hover:text-pl1"
                              >
                                ⋯
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      </PageFrame>
      {usagePop && usageMap[usagePop.id] && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setUsagePop(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute w-56 rounded-md border border-field bg-strip p-3 text-xs shadow-xl"
            style={{ left: usagePop.x, top: usagePop.y }}
          >
            {(() => {
              const u = usageMap[usagePop.id]!;
              return (
                <>
                  <div className="mb-1 font-medium text-pl1">用量 / 费用（官方价）</div>
                  <div className="flex justify-between py-0.5 text-pl2">
                    <span>输入</span>
                    <span>{fmtTokens(u.input)}</span>
                  </div>
                  <div className="flex justify-between py-0.5 text-pl2">
                    <span>输出</span>
                    <span>{fmtTokens(u.output)}</span>
                  </div>
                  <div className="flex justify-between py-0.5 text-pl2">
                    <span>费用</span>
                    <span>
                      {u.costUsd != null
                        ? `${u.costPartial ? "≥" : ""}$${u.costUsd.toFixed(2)}`
                        : "~"}
                    </span>
                  </div>
                  <p className="mt-1 text-l4">按模型近似归属；模型跨配置共享时会重复计入</p>
                </>
              );
            })()}
          </div>
        </div>
      )}
      {modal && (
        <ProfileModal
          initial={modal.initial}
          presetAgent={modal.presetAgent}
          onClose={() => setModal(null)}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              label: "复制",
              onSelect: () => {
                const p = rowMenu.profile;
                void (async () => {
                  try {
                    await duplicateProfile(p.id);
                  } catch (e) {
                    setError(String(e));
                  }
                })();
              },
            },
            { label: "设为全局", onSelect: () => void onApplyGlobal(rowMenu.profile) },
            ...(globalBackups[rowMenu.profile.agent]
              ? [
                  {
                    label: "恢复备份",
                    onSelect: () => void onRestoreBackup(rowMenu.profile.agent),
                  },
                ]
              : []),
            { label: "删除", onSelect: () => void onDelete(rowMenu.profile) },
          ]}
        />
      )}
    </div>
  );
}
