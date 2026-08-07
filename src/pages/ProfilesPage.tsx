import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS } from "../types";
import { PRESETS } from "../presets";
import { upstreamNoteText, upstreamCommand } from "../upstream-note";
import { interactiveUpdatePrefill } from "../update-routing";
import { absTime, relTime } from "../rel-time";
import ContextMenu from "../components/ContextMenu";
import {
  PageFrame,
  PageHeader,
  PageToolbar,
  primaryActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import type {
  GlobalApplyResultDto,
  OfficialAccountStatusDto,
  Profile,
  ProfileInput,
  ProfileUsageDto,
  ProfileValidationDto,
  ValidationCheckDto,
} from "../types";

function ProfileModal({
  initial,
  presetAgent,
  officialSupported,
  onClose,
}: {
  initial: Profile | null;
  /** 从某个 agent 组的「+ 添加配置」打开时预选该 agent */
  presetAgent?: string;
  /** 各 agent 是否支持官方账号（来自 official_account_status） */
  officialSupported: Record<string, boolean>;
  onClose: () => void;
}) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const [form, setForm] = useState({
    agent: initial?.agent ?? presetAgent ?? "claude-code",
    name: initial?.name ?? "",
    accountType: (initial?.accountType ?? "api") as "api" | "official",
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
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
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
      accountType: form.accountType,
      protocol: AGENT_PROTOCOLS[form.agent] ? form.protocol : null,
      // 官方账号：认证交给 CLI 登录，不落端点/密钥
      baseUrl: form.accountType === "official" ? "" : form.baseUrl.trim(),
      models: form.models,
      extraEnv: parseEnvLines(form.extraEnvText),
      apiKey: form.accountType === "official" ? null : form.apiKey || null,
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
              onChange={(e) => {
                setForm({
                  ...form,
                  agent: e.target.value,
                  // 新 agent 不支持官方账号时回落 api
                  accountType: officialSupported[e.target.value]
                    ? form.accountType
                    : "api",
                  protocol: AGENT_PROTOCOLS[e.target.value]?.default ?? null,
                });
                // 端点测试/模型拉取结果属于旧 agent，切换后一并清空
                setTestResult(null);
                setFetchError(null);
                setFetchedModels(null);
              }}
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
        {officialSupported[form.agent] && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">账号类型</span>
            <select
              className={field}
              value={form.accountType}
              onChange={(e) =>
                setForm({
                  ...form,
                  accountType: e.target.value as "api" | "official",
                })
              }
            >
              <option value="api">API 端点 + 密钥</option>
              <option value="official">官方账号（用 CLI 登录，无需密钥）</option>
            </select>
          </label>
        )}
        {form.accountType === "official" && (
          <p className="-mt-1 mb-3 text-xs text-l3">
            官方账号配置启动时不注入端点与密钥，使用 CLI 自身的账号登录；模型可留空（用
            CLI 默认模型）。请先在组内「官方账号」行完成连接。
          </p>
        )}
        {form.accountType === "api" && (
          <>
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
              title={
                form.baseUrl.trim() ? "验证端点与密钥连通性" : "先填写 Base URL"
              }
              className="w-20 shrink-0 rounded bg-btn px-2 py-1 text-xs text-l1 hover:bg-white/10 disabled:opacity-50"
            >
              {testing ? "测试中…" : "测试"}
            </button>
          </div>
        </label>
        {testResult && (
          <p
            className={`-mt-2 mb-3 text-xs ${testResult.ok ? "text-ok-text" : "text-err-text"}`}
          >
            {testResult.text}
          </p>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">API Key</span>
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            placeholder={
              initial ? "留空则不修改" : "存入本地受限文件（0600），不回显"
            }
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
          </>
        )}
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
                {sw.max != null
                  ? `最多 ${sw.max} 个模型可进入 CLI 选择器`
                  : "模型数量不限"}
                {over && `；当前超出 ${form.models.length - (sw.max ?? 0)} 个`}
              </p>
            );
          })()}
          {form.accountType === "api" && (
            <>
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={fetchModels}
              disabled={fetching || !form.baseUrl.trim()}
              title={
                form.baseUrl.trim()
                  ? "从 Base URL 拉取可用模型"
                  : "先填写 Base URL"
              }
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
          {fetchError && (
            <p className="mb-2 text-xs text-err-text">{fetchError}</p>
          )}
            </>
          )}
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
                      setForm({
                        ...form,
                        models: form.models.filter((x) => x !== m),
                      })
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
                  onChange={(e) =>
                    setForm({ ...form, protocol: e.target.value })
                  }
                >
                  {AGENT_PROTOCOLS[form.agent].options.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
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
                placeholder={
                  "HTTPS_PROXY=http://127.0.0.1:7890\nANTHROPIC_SMALL_FAST_MODEL=claude-haiku"
                }
                value={form.extraEnvText}
                onChange={(e) =>
                  setForm({ ...form, extraEnvText: e.target.value })
                }
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
  /** brew 渠道滞后提示：上游 npm 已更新的版本号；查不到为 null */
  upstreamNote: string | null;
  /** 上游 npm 包名（配套 upstreamNote，供复制 npm 安装命令） */
  upstreamPackage: string | null;
  /** 渠道切换一体命令（brew 卸载 + npm 安装），配套 upstreamNote */
  upstreamCommand: string | null;
  /** 本次更新将走交互式 TUI 自更新（kimi upgrade 方向键选择界面）：更新改在完整终端执行 */
  interactiveTui: boolean;
  /** 交互式自更新的终端预填命令（interactiveTui 为 true 时必有值） */
  interactiveUpdateCommand: string | null;
}

/** 各 agent 在 TUI 模型切换页可用的模型数上限（注入模式；matrix 调研结论）。
 *  max = null 表示不限（选择器列出全部已配置模型） */
const MODEL_SWITCH: Record<string, { max: number | null; hint: string }> = {
  "claude-code": {
    max: 5,
    hint: "前 4 个占 SONNET/OPUS/HAIKU/FABLE 别名槽，第 5 个占自定义槽；超出的只能 /model <id> 手输",
  },
  codex: {
    max: null,
    hint: "启动时生成模型 catalog，/model 选择器列出全部已配置模型",
  },
  gemini: {
    max: 1,
    hint: "CLI 无多模型注入机制，多模型只能在 TUI 里 /model set 手动切换",
  },
  qwen: {
    max: 1,
    hint: "多模型需「⋯ → 设为全局」写入配置后才能在 /model 里切换",
  },
  opencode: { max: null, hint: "全部已配置模型都会注册，可在 TUI 自由切换" },
  kimi: { max: 1, hint: "多模型需「⋯ → 设为全局」写入配置后才能在模型页切换" },
};

/** 各 CLI 断开官方账号的方式（Ccode 不删 auth 文件，引导用 CLI 自己的 logout；
 *  命令按官方文档/CLI help 核实，见 agent_specs.rs 的 official_account 注释） */
const OFFICIAL_LOGOUT_HINT: Record<string, string> = {
  "claude-code": "claude auth logout（或 TUI 内 /logout）",
  codex: "codex logout",
  gemini: "TUI 内 /auth signout",
  codebuddy: "TUI 内 /logout",
  cursor: "cursor-agent logout",
  kimi: "TUI 内 /logout",
  qwen: "TUI 内 /auth",
};

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
    return authority && /^[\w.:[\]-]+$/.test(authority)
      ? authority
      : "自定义端点";
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

function validationTone(status: ValidationCheckDto["status"]): string {
  if (status === "passed") return "text-ok-text";
  if (status === "failed") return "text-err-text";
  return "text-l4";
}

function ValidationDialog({
  profile,
  result,
  running,
  onClose,
}: {
  profile: Profile;
  result: ProfileValidationDto | null;
  running: boolean;
  onClose: () => void;
}) {
  const rows: Array<[string, ValidationCheckDto | null]> = [
    ["本地配置解析", result?.local ?? null],
    ["CLI 预检", result?.cli ?? null],
    ["API / 模型", result?.api ?? null],
  ];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <section
        className="w-full max-w-xl rounded-lg border border-field bg-strip"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-l1">
              验证配置 · {profile.name}
            </h2>
            <p className="mt-0.5 text-xs text-l4">
              密钥只在后端用于预检，不会返回界面
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 rounded px-2 text-xs text-l3 hover:bg-white/5 hover:text-l1"
          >
            关闭
          </button>
        </header>
        <div className="divide-y divide-hairline">
          {rows.map(([label, item], index) => (
            <div
              key={label}
              className="grid grid-cols-[24px_112px_1fr] gap-2 px-4 py-3 text-xs"
            >
              <span className={item ? validationTone(item.status) : "text-l4"}>
                {item?.status === "passed"
                  ? "✓"
                  : item?.status === "failed"
                    ? "✗"
                    : "—"}
              </span>
              <span className="font-medium text-l2">{label}</span>
              <div className="min-w-0 text-l3">
                <p className="break-words">
                  {item?.message ??
                    (running && index === 0 ? "正在检查…" : "等待检查")}
                </p>
                {item?.latencyMs != null && (
                  <span className="mt-1 block font-mono text-l4">
                    {item.latencyMs}ms
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        <footer className="border-t border-hairline px-4 py-3 text-xs">
          {running ? (
            <span className="text-l3">
              正在执行 CLI 与最小模型列表请求，最长约 35 秒…
            </span>
          ) : result ? (
            <span className={result.ok ? "text-ok-text" : "text-err-text"}>
              {result.ok
                ? "✓ 三层验证完成"
                : "✗ 存在未通过项目，请按上方信息修复后重试"}
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

/** 后端恒返回用量 DTO，零用量（全 0）不显示「用量与费用」入口 */
function hasUsage(u: ProfileUsageDto | undefined): boolean {
  return !!u && (u.input > 0 || u.output > 0);
}

export default function ProfilesPage() {
  const profiles = useAppStore((s) => s.profiles);
  const [usageMap, setUsageMap] = useState<Record<string, ProfileUsageDto>>({});
  const [usagePop, setUsagePop] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);

  // 各 profile 用量（按模型近似归属；模型跨 profile 共享时会重复计入）
  useEffect(() => {
    // profiles 清空时同步清表，避免残留已删除 profile 的陈旧条目
    if (!profiles.length) {
      setUsageMap({});
      return;
    }
    // profiles 快速变化时旧批次可能晚返回，cancelled 阻止整表覆盖新结果
    let cancelled = false;
    Promise.all(
      profiles.map(async (p) => {
        try {
          return [
            p.id,
            await invoke<ProfileUsageDto>("profile_usage", { profileId: p.id }),
          ] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const m: Record<string, ProfileUsageDto> = {};
      for (const e of entries) if (e) m[e[0]] = e[1];
      setUsageMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  // 用量悬浮卡：Escape / 任意滚动即关闭（同 ContextMenu；滚动关闭也避免与锚点脱离）
  useEffect(() => {
    if (!usagePop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUsagePop(null);
    };
    // capture 阶段的滚动监听能捕获任意容器的滚动
    const onScroll = () => setUsagePop(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [usagePop]);
  const agents = useAppStore((s) => s.agents);
  const removeProfile = useAppStore((s) => s.removeProfile);
  const duplicateProfile = useAppStore((s) => s.duplicateProfile);
  const loadAll = useAppStore((s) => s.loadAll);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);
  // 各 agent 官方账号连接状态（P1a；仅 supported 的 agent 会展示状态行）
  const [officialStatus, setOfficialStatus] = useState<
    Record<string, OfficialAccountStatusDto>
  >({});

  /** 重新检测某个 agent 的官方账号连接状态（只读 auth 文件，失败不影响页面） */
  async function refreshOfficial(agentId: string) {
    try {
      const st = await invoke<OfficialAccountStatusDto>(
        "official_account_status",
        { agentId },
      );
      setOfficialStatus((prev) => ({ ...prev, [agentId]: st }));
    } catch {
      /* 检测失败不影响页面 */
    }
  }

  useEffect(() => {
    for (const a of AGENTS) void refreshOfficial(a.id);
  }, []);

  /** 「连接」：在内嵌终端开新标签执行 CLI 登录命令（OAuth 会弹浏览器）；完成后回本页点「刷新」 */
  function connectOfficial(agentId: string) {
    const st = officialStatus[agentId];
    if (!st?.loginCommand) return;
    setPendingTerminal({
      cwd: "~",
      extraEnv: {},
      title: `登录 ${labelOf(agentId)}`,
      prefillCommand: st.loginCommand,
      shellOnly: true,
    });
    setPage("terminal");
  }
  const [modal, setModal] = useState<{
    initial: Profile | null;
    presetAgent?: string;
  } | null>(null);
  const [topMenu, setTopMenu] = useState<{ x: number; y: number } | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    profile: Profile;
  } | null>(null);
  const [validationDialog, setValidationDialog] = useState<{
    profile: Profile;
    result: ProfileValidationDto | null;
    running: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 过滤条：按安装状态过滤 agent 组；按名称/端点/模型过滤配置行
  const [statusFilter, setStatusFilter] = useState<
    "all" | "installed" | "uninstalled"
  >("all");
  const [search, setSearch] = useState("");
  // 组折叠状态：首次使用默认全部展开，手动折叠后持久化到 localStorage
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(loadCollapsedGroups);

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
  const [globalBackups, setGlobalBackups] = useState<Record<string, boolean>>(
    {},
  );
  // 各 agent 的升级/安装进行态、实时输出与最近结果（可并发操作多个 agent）
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  const [liveOutput, setLiveOutput] = useState<Record<string, string>>({});
  const [updateResults, setUpdateResults] = useState<
    Record<string, AgentCmdResult>
  >({});
  // 各 agent 最新版检查（组头「新版/已更新」状态；查不到渠道的组头回退普通「更新」按钮）
  const [updateInfo, setUpdateInfo] = useState<Record<string, AgentUpdateInfo>>(
    {},
  );

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
  async function runAgentCmd(
    agentId: string,
    command: "update_agent" | "install_agent",
  ) {
    setUpdating((prev) => ({ ...prev, [agentId]: true }));
    setLiveOutput((prev) => ({ ...prev, [agentId]: "" }));
    lastChunkAtRef.current[agentId] = Date.now();
    // 闲置提醒用的节拍器：每 15s 触发一次重渲染，run 结束即清
    const idleTimer = setInterval(() => setIdleTick((t) => t + 1), 15000);
    const unOut = await listen<string>(
      `agent-update-output-${agentId}`,
      (e) => {
        lastChunkAtRef.current[agentId] = Date.now();
        setLiveOutput((prev) => ({
          ...prev,
          [agentId]: (prev[agentId] ?? "") + e.payload,
        }));
      },
    );
    let doneArrived = false;
    const unDone = await listen<AgentCmdResult>(
      `agent-update-done-${agentId}`,
      (e) => {
        doneArrived = true;
        setUpdateResults((prev) => ({ ...prev, [agentId]: e.payload }));
      },
    );
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

  /** 升级某个 agent 的 CLI；完成后重新 detect 刷新版本号。
   *  交互式 TUI 自更新（kimi upgrade 方向键选择界面）行输入无法应答，
   *  与官方账号「连接」同款：开完整终端让用户用方向键操作 */
  async function onUpdate(agentId: string) {
    const prefill = interactiveUpdatePrefill(updateInfo[agentId]);
    if (prefill) {
      setPendingTerminal({
        cwd: "~",
        extraEnv: {},
        title: `更新 ${labelOf(agentId)}`,
        prefillCommand: prefill,
        shellOnly: true,
      });
      setPage("terminal");
      return;
    }
    await runAgentCmd(agentId, "update_agent");
  }

  /** 安装未装的 agent：先亮出将执行的命令，用户确认后才跑 */
  async function onInstall(agentId: string) {
    try {
      const method = await invoke<string | null>("install_method_preview", {
        agentId,
      });
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

  // hover 才现的低频操作：键盘 Tab 聚焦（focus-visible）同样显示，保持可达
  const hoverReveal =
    "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

  /** 每个 agent 是否有可恢复的完整全局配置批次（控制「恢复备份」按钮显隐） */
  async function refreshGlobalBackups() {
    const entries = await Promise.all(
      AGENTS.map(
        async (a) =>
          [
            a.id,
            await invoke<boolean>("has_global_backup", { agent: a.id }),
          ] as const,
      ),
    );
    setGlobalBackups(Object.fromEntries(entries));
  }

  useEffect(() => {
    refreshGlobalBackups().catch(() => {});
  }, [profiles]);

  /** 把 profile 事务化写入该 CLI 的全部目标文件，UI 明示影响范围 */
  async function onApplyGlobal(p: Profile) {
    if (
      !window.confirm(
        `将把该配置写入 ${labelOf(p.agent)} 的全局配置文件（影响其他终端里的使用）。全部文件会作为一个批次写入，失败会自动回滚；当前内容会先备份。继续？`,
      )
    )
      return;
    try {
      const applied = await invoke<GlobalApplyResultDto>(
        "apply_profile_global",
        {
          profileId: p.id,
        },
      );
      await refreshGlobalBackups();
      const cli = applied.validation.cli;
      window.alert(
        `已写入全局配置：\n${applied.files.join("\n")}\n\nCLI 配置检查：${
          cli.status === "passed" ? "通过" : "未通过"
        }\n${cli.message}`,
      );
      if (!applied.validation.ok) {
        setValidationDialog({
          profile: p,
          result: applied.validation,
          running: false,
        });
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onValidate(p: Profile) {
    setValidationDialog({ profile: p, result: null, running: true });
    try {
      const result = await invoke<ProfileValidationDto>("validate_profile", {
        profileId: p.id,
      });
      setValidationDialog({ profile: p, result, running: false });
      setError(null);
    } catch (e) {
      setValidationDialog(null);
      setError(String(e));
    }
  }

  /** 恢复该 agent 最近一个完整备份批次；恢复前先备份当前状态。 */
  async function onRestoreBackup(agentId: string) {
    if (
      !window.confirm(
        `将恢复 ${labelOf(agentId)} 最近一个完整备份批次。当前状态会先另存为新备份，原恢复点不会被消耗。继续？`,
      )
    )
      return;
    try {
      const files = await invoke<string[]>("restore_global_backup", {
        agent: agentId,
      });
      await refreshGlobalBackups();
      window.alert(
        files.length
          ? `已恢复完整批次：\n${files.join("\n")}`
          : "没有可恢复的完整备份批次",
      );
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
    if (!window.confirm(`删除配置「${p.name}」？本地受限存储的密钥会一并删除。`))
      return;
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
                type="button"
                onClick={() => setModal({ initial: null })}
                className={primaryActionClass}
              >
                + 新建配置
              </button>
              <button
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTopMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                }}
                title="更多配置操作"
                aria-label="更多配置操作"
                className="flex h-8 w-8 items-center justify-center rounded text-sm text-pl2 hover:bg-white/5 hover:text-pl1"
              >
                ⋯
              </button>
            </>
          }
        />

        {/* 过滤条：状态筛选胶囊（选中=实心 seg-sel）+ 右侧搜索框 */}
        <PageToolbar>
          <div className="flex items-center gap-1">
            {(
              [
                ["all", "全部"],
                ["installed", "已安装"],
                ["uninstalled", "未安装"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                aria-pressed={statusFilter === k}
                onClick={() => setStatusFilter(k)}
                className={`flex h-7 items-center rounded-full px-3 text-xs ${
                  statusFilter === k
                    ? "bg-seg-sel text-pl1"
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
          {/* 搜索框：inset 底 + hairline 细边（同对话页手法） */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称 / 端点 / 模型"
            className="h-8 w-56 rounded-md border border-hairline bg-inset px-2.5 text-xs text-pl2 outline-none placeholder:text-l4 focus:border-field"
          />
        </PageToolbar>

        {error && <p className="mt-4 text-sm text-err-text">{error}</p>}

        {/* agent 分组（可折叠） */}
        <div>
          {visibleAgents.map((agent) => {
            const det = agents.find((a) => a.id === agent.id);
            const list = profiles.filter(
              (p) => p.agent === agent.id && matchProfile(p),
            );
            if (q && list.length === 0) return null;
            const isCollapsed = collapsedGroups.has(agent.id);
            // 分组收敛掉外框/底色：hairline 分隔 + 左侧缩进线分层（同工作区项目组手法）
            return (
              <section key={agent.id} className="mb-5">
                <div className="group flex h-10 items-center gap-2 border-b border-hairline px-3">
                  <button
                    onClick={() => {
                      // 更新/安装进行中禁止折叠，避免交互输入行（如 brew [y/n]）被隐藏
                      if (updating[agent.id] && !isCollapsed) return;
                      updateCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        return next;
                      });
                    }}
                    aria-label={isCollapsed ? "展开" : "收起"}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-sm text-pl2 hover:bg-white/5 hover:text-pl1"
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <h2 className="text-sm font-medium text-pl1">
                    {agent.label}
                  </h2>
                  {/* 已安装显示包名+版本号（mono）；右侧状态：更新中… / 新版（可点更新）/ 更新（查不到最新版时的回退）；已是最新则不显示 */}
                  {det?.binaryPath ? (
                    <span className="font-mono text-xs text-l4">
                      {agent.binary} {det.version ?? ""}
                    </span>
                  ) : (
                    <span className="text-xs text-pl2">
                      未安装（<span className="font-mono">{agent.binary}</span>{" "}
                      不在 PATH）
                    </span>
                  )}
                  {det?.binaryPath ? (
                    (() => {
                      if (updating[agent.id])
                        return (
                          <span className="ml-auto text-xs text-pl2">
                            更新中…
                          </span>
                        );
                      const info = updateInfo[agent.id];
                      const tuiPrefill = interactiveUpdatePrefill(info);
                      if (updateResults[agent.id]?.ok) return null;
                      if (info && !info.outdated && info.latest) {
                        // 已最新：仅在 brew 渠道滞后于上游 npm 时挂小字提示，否则不显示
                        const note = upstreamNoteText(info);
                        const cmd = upstreamCommand(info);
                        return note ? (
                          <span className="ml-auto flex items-center gap-1 text-xs text-l4">
                            <span title={note}>{note}</span>
                            {cmd && (
                              <button
                                type="button"
                                title={`复制渠道切换命令：${cmd}\n含义：卸载 brew 版本并改装 npm 版本（之后更新走 npm 渠道，Ccode 自动按 npm 检查）`}
                                onClick={() =>
                                  void navigator.clipboard.writeText(cmd)
                                }
                                className={`flex size-6 items-center justify-center rounded text-l4 hover:bg-white/5 hover:text-l1 ${hoverReveal}`}
                              >
                                ⧉
                              </button>
                            )}
                          </span>
                        ) : null;
                      }
                      if (info?.outdated)
                        return (
                          <button
                            onClick={() => onUpdate(agent.id)}
                            title={
                              tuiPrefill
                                ? `有新版本 ${info.latest ?? ""}；交互式更新（${tuiPrefill}），将在终端中打开，需方向键选择`
                                : `有新版本 ${info.latest ?? ""}，点击更新`
                            }
                            className="ml-auto flex h-8 items-center rounded px-2 text-xs text-cta hover:bg-white/5 hover:brightness-125"
                          >
                            新版
                          </button>
                        );
                      return (
                        <button
                          onClick={() => onUpdate(agent.id)}
                          title={
                            tuiPrefill
                              ? `交互式更新（${tuiPrefill}），将在终端中打开，需方向键选择`
                              : undefined
                          }
                          className="ml-auto flex h-8 items-center rounded px-2 text-xs text-pl2 hover:bg-white/5 hover:text-pl1"
                        >
                          更新
                        </button>
                      );
                    })()
                  ) : (
                    <button
                      onClick={() => onInstall(agent.id)}
                      disabled={updating[agent.id]}
                      className={`${secondaryActionClass} ml-auto px-2.5`}
                    >
                      {updating[agent.id] ? "安装中…" : "安装"}
                    </button>
                  )}
                </div>

                {!isCollapsed && (
                  <div className="border-l border-white/5">
                    {/* 官方账号状态行（P1a）：支持官方账号的 agent 固定展示；断开走 CLI 自己的 logout，Ccode 不删 auth 文件 */}
                    {officialStatus[agent.id]?.supported &&
                      (() => {
                        const st = officialStatus[agent.id];
                        return (
                          <div className="flex items-center gap-2 border-b border-hl2 px-3 py-1.5 text-xs">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.connected ? "bg-okb" : "bg-l4"}`}
                            />
                            <span className="shrink-0 text-pl2">官方账号</span>
                            <span
                              className={`shrink-0 ${st.connected ? "text-okb" : "text-l4"}`}
                            >
                              {st.connected ? "已连接" : "未连接"}
                            </span>
                            {st.detail && (
                              <span
                                className="min-w-0 truncate text-l4"
                                title={st.detail}
                              >
                                {st.detail}
                              </span>
                            )}
                            {st.connected && OFFICIAL_LOGOUT_HINT[agent.id] && (
                              <span className="shrink-0 text-l4">
                                断开：{OFFICIAL_LOGOUT_HINT[agent.id]}
                              </span>
                            )}
                            {/* 配置文件冲突警告（P1a）：CLI 自读文件里的残留密钥会覆盖官方账号登录，悬停列出各项 */}
                            {st.conflicts.length > 0 && (
                              <span
                                className="flex shrink-0 items-center gap-1 text-warnb"
                                title={`${st.conflicts.join("\n")}\n该文件中的密钥会覆盖官方账号登录，产生 API 计费`}
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-warnb" />
                                {st.conflicts.length} 项配置冲突
                              </span>
                            )}
                            <span className="ml-auto flex shrink-0 items-center gap-1">
                              {!st.connected && (
                                <button
                                  onClick={() => connectOfficial(agent.id)}
                                  title={`在终端执行 ${st.loginCommand ?? ""}`}
                                  className="h-7 rounded border border-field bg-strip px-2 text-xs text-pl2 hover:bg-inset hover:text-pl1"
                                >
                                  连接
                                </button>
                              )}
                              <button
                                onClick={() => void refreshOfficial(agent.id)}
                                title="重新检测连接状态"
                                className="h-7 rounded px-2 text-xs text-pl2 hover:bg-white/5 hover:text-pl1"
                              >
                                刷新
                              </button>
                            </span>
                          </div>
                        );
                      })()}
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
                          const idleMin = last
                            ? Math.floor((Date.now() - last) / 60000)
                            : 0;
                          if (idleMin < 2) return null;
                          return (
                            <div className="bg-warn px-2 py-1 text-xs text-warn-text">
                              已 {idleMin}{" "}
                              分钟无新输出：可能是网络慢，或命令在等待输入（在下方输入行回答）。若持续异常可把当前内容发给开发者。
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-1.5 rounded-b border border-hl2 bg-pg px-2 py-1.5">
                          <span className="font-mono text-xs text-l4">
                            &gt;
                          </span>
                          <input
                            value={cmdInput[agent.id] ?? ""}
                            onChange={(e) =>
                              setCmdInput((prev) => ({
                                ...prev,
                                [agent.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter")
                                void sendUpdaterInput(agent.id);
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
                            updateResults[agent.id].ok
                              ? "text-okb"
                              : "text-err-text"
                          }
                        >
                          {updateResults[agent.id].ok
                            ? "✓ 更新完成"
                            : "✗ 更新失败"}
                        </span>
                        <span>
                          {updateResults[agent.id].method &&
                            `（${updateResults[agent.id].method}）`}
                          {updateResults[agent.id].versionAfter &&
                            `：${updateResults[agent.id].versionBefore ?? "?"} → ${updateResults[agent.id].versionAfter}`}
                        </span>
                        {updateResults[agent.id].output && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-l3">
                              输出
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                              {updateResults[agent.id].output}
                            </pre>
                          </details>
                        )}
                        {(() => {
                          const r = updateResults[agent.id];
                          const hint = r.ok
                            ? null
                            : diagnose(r.output, r.method);
                          return hint ? (
                            <p className="mt-1 text-xs text-l3">
                              ⓘ 建议：{hint}
                            </p>
                          ) : null;
                        })()}
                      </div>
                    )}

                    {list.length === 0 ? (
                      <div className="flex h-12 items-center justify-between px-3">
                        <span className="text-sm text-l4">暂无配置</span>
                        <button
                          onClick={() =>
                            setModal({ initial: null, presetAgent: agent.id })
                          }
                          className="text-xs text-pl2 hover:text-pl1"
                        >
                          + 添加配置
                        </button>
                      </div>
                    ) : (
                      <ul className="divide-y divide-hl2 overflow-x-auto">
                        {list.map((profile) => (
                          <li
                            key={profile.id}
                            className="group grid min-h-14 grid-cols-[minmax(130px,1fr)_minmax(150px,1fr)_minmax(150px,1fr)_110px_92px] items-center gap-3 px-3 text-sm"
                          >
                            <span className="min-w-0">
                              <span
                                className="block truncate font-medium text-pl1"
                                title={profile.name}
                              >
                                {profile.name}
                              </span>
                              {/* 次级行：10px 灰字，相对时间主显、悬浮给绝对时间（白话双层）；从未使用不渲染 */}
                              {profile.lastUsedAt && (
                                <span
                                  className="mt-0.5 block truncate font-mono text-[10px] text-l4"
                                  title={`上次使用 ${absTime(profile.lastUsedAt)}`}
                                >
                                  上次使用 {relTime(profile.lastUsedAt)}
                                </span>
                              )}
                            </span>
                            <span
                              className={`min-w-0 truncate text-xs ${profile.baseUrl || profile.accountType === "official" ? "text-pl2" : "text-l4"}`}
                              title={
                                profile.accountType === "official"
                                  ? "官方账号登录（CLI 自身认证，不注入端点/密钥）"
                                  : profile.baseUrl
                                    ? displayHost(profile.baseUrl)
                                    : "使用 CLI 默认端点"
                              }
                            >
                              {profile.accountType === "official"
                                ? "官方账号"
                                : profile.baseUrl
                                  ? displayHost(profile.baseUrl)
                                  : "默认端点"}
                            </span>
                            <span
                              className={`min-w-0 truncate font-mono text-xs ${
                                profile.models[0] ? "text-pl2" : "text-l4"
                              }`}
                              title={
                                profile.models.length > 1
                                  ? profile.models.join(" · ")
                                  : profile.models[0]
                              }
                            >
                              {profile.models[0] ?? "未指定模型"}
                            </span>
                            {profile.accountType === "official" ? (
                              <span
                                className="flex items-center gap-1 text-xs text-l4"
                                title="官方账号登录，无需 API 密钥"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-l4" />
                                无需密钥
                              </span>
                            ) : (
                            <span
                              className={`flex items-center gap-1 text-xs ${
                                profile.hasKey ? "text-okb" : "text-pl2"
                              }`}
                              title={
                                profile.hasKey
                                  ? `密钥已受限存储${profile.keyHint ? `（${profile.keyHint}）` : ""}`
                                  : "尚未填写密钥"
                              }
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  profile.hasKey ? "bg-okb" : "bg-l4"
                                }`}
                              />
                              {profile.hasKey ? "已设置" : "未设置"}
                            </span>
                            )}
                            <span className="flex items-center justify-end gap-1 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setModal({ initial: profile })}
                                className="h-8 rounded px-2 text-xs text-pl2 hover:bg-white/5 hover:text-pl1"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  const rect =
                                    event.currentTarget.getBoundingClientRect();
                                  setRowMenu({
                                    x: rect.right - 176,
                                    y: rect.bottom + 4,
                                    profile,
                                  });
                                }}
                                aria-label={`更多操作：${profile.name}`}
                                className={`flex h-8 w-8 items-center justify-center rounded text-sm text-l4 hover:bg-white/5 hover:text-pl1 ${hoverReveal}`}
                              >
                                ⋯
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </PageFrame>
      {usagePop && usageMap[usagePop.id] && (
        <div className="fixed inset-0 z-20" onClick={() => setUsagePop(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute w-56 rounded-md border border-field bg-strip p-3 text-xs"
            // 防出屏：往左/往上收（卡片 w-56 约 224px、高约 170px）
            style={{
              left: Math.max(8, Math.min(usagePop.x, window.innerWidth - 240)),
              top: Math.max(8, Math.min(usagePop.y, window.innerHeight - 180)),
            }}
          >
            {(() => {
              const u = usageMap[usagePop.id]!;
              return (
                <>
                  <div className="mb-1 font-medium text-pl1">
                    用量 / 费用（官方价）
                  </div>
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
                  <p className="mt-1 text-l4">
                    按模型近似归属；模型跨配置共享时会重复计入
                  </p>
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
          officialSupported={Object.fromEntries(
            Object.entries(officialStatus).map(([k, v]) => [k, v.supported]),
          )}
          onClose={() => setModal(null)}
        />
      )}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          onClose={() => setTopMenu(null)}
          items={[
            { label: "导入配置", onSelect: () => void onImport() },
            { label: "导出配置", onSelect: () => void onExport() },
          ]}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            ...(hasUsage(usageMap[rowMenu.profile.id])
              ? [
                  {
                    label: "用量与费用",
                    onSelect: () =>
                      setUsagePop({
                        x: Math.max(8, rowMenu.x - 232),
                        y: rowMenu.y,
                        id: rowMenu.profile.id,
                      }),
                  },
                ]
              : []),
            {
              label: "复制配置",
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
            { label: "验证", onSelect: () => void onValidate(rowMenu.profile) },
            {
              label: "设为全局",
              onSelect: () => void onApplyGlobal(rowMenu.profile),
            },
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
      {validationDialog && (
        <ValidationDialog
          profile={validationDialog.profile}
          result={validationDialog.result}
          running={validationDialog.running}
          onClose={() => {
            if (!validationDialog.running) setValidationDialog(null);
          }}
        />
      )}
    </div>
  );
}
