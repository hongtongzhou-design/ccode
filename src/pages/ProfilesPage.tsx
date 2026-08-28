import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SquareArrowOutUpRight, SquareTerminal } from "lucide-react";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS } from "../types";
import { PRESETS, NO_PRESET_REASON } from "../presets";
import { upstreamNoteText, upstreamCommand } from "../upstream-note";
import { copyTargets } from "../profile-copy";
import { MODEL_SWITCH } from "../model-switch";
import { interactiveUpdatePrefill } from "../update-routing";
import { absTime, relTime } from "../rel-time";
import ContextMenu from "../components/ContextMenu";
import { HoverTip, useHoverTip } from "../components/HoverTip";
import { alertDialog, confirmDialog } from "../components/ConfirmDialog";
import {
  PageFrame,
  NoticeBar,
  PageHeader,
  PageToolbar,
  SegTabs,
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  primaryActionClass,
  rowActionClass,
  searchFieldClass,
  secondaryActionClass,
} from "../components/PageFrame";
import type {
  AgentCapabilitiesDto,
  GlobalApplyResultDto,
  OfficialAccountStatusDto,
  Profile,
  ProfileInput,
  ModelCapabilityDto,
  ProfileUsageDto,
  ProfileValidationDto,
  ValidationCheckDto,
} from "../types";

function ProfileModal({
  initial,
  presetAgent,
  officialSupported,
  onClose,
  onSaved,
}: {
  initial: Profile | null;
  /** 从某个 agent 组的「+ 添加连接」打开时预选该 agent */
  presetAgent?: string;
  /** 各 agent 是否支持官方账号（来自 official_account_status） */
  officialSupported: Record<string, boolean>;
  onClose: () => void;
  /** 保存成功回调：页面据此判断要不要提示「该 agent 有标签在跑，需重开才生效」 */
  onSaved?: (agent: string, name: string) => void;
}) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const [form, setForm] = useState({
    agent: initial?.agent ?? presetAgent ?? "claude-code",
    name: initial?.name ?? "",
    accountType: (initial?.accountType ?? "api") as "api" | "official",
    noAuth: initial?.noAuth ?? false,
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
  const [capabilities, setCapabilities] = useState<ModelCapabilityDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!form.models.length) {
      setCapabilities([]);
      return;
    }
    void invoke<ModelCapabilityDto[]>("model_capabilities", { models: form.models })
      .then((items) => {
        if (!cancelled) setCapabilities(items);
      })
      .catch(() => {
        if (!cancelled) setCapabilities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [form.models]);

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
        agentId: form.agent,
        protocol: form.protocol,
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
        agentId: form.agent,
        protocol: form.protocol,
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
      noAuth: form.accountType === "api" && form.noAuth,
      protocol: AGENT_PROTOCOLS[form.agent] ? form.protocol : null,
      // 官方账号：认证交给 CLI 登录，不落端点/密钥
      baseUrl: form.accountType === "official" ? "" : form.baseUrl.trim(),
      models: form.models,
      extraEnv: parseEnvLines(form.extraEnvText),
      apiKey: form.accountType === "official" ? null : form.apiKey || null,
    };
    try {
      await saveProfile(initial?.id ?? null, input);
      onSaved?.(input.agent, input.name);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] ccode-fade"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="max-h-[min(680px,calc(100vh-32px))] w-full max-w-[500px] overflow-y-auto rounded-lg border border-field ccode-float-surface p-4 sm:p-5"
      >
        <div className="mb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-l1">
              {initial ? "编辑连接" : "添加连接"}
            </h2>
            <p className="mt-1 text-xs text-l4">
              配置一个可在运行页启动的 Agent 连接。
            </p>
          </div>
        </div>

        <section className="mb-4 rounded-lg border border-hairline bg-strip/45 p-3">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs font-medium text-l2">快速开始</span>
            <span className="text-micro text-l4">可选，选择后会自动填入基础字段</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
          {/* 没有预设的 agent（gemini/cursor）不给空下拉——空选择器看起来像功能坏了，
              而这两家「本来就不该有预设」（原因见 presets.ts NO_PRESET_REASON） */}
          {PRESETS.every((p) => p.agent !== form.agent) ? (
            <div>
              <span className="mb-1 block text-xs text-l3">端点预设</span>
              <p className="rounded-md border border-dashed border-field px-2.5 py-2 text-micro leading-4 text-l4">
                {NO_PRESET_REASON[form.agent] ?? "这个 agent 暂无内置端点预设，请手动填写 Base URL。"}
              </p>
            </div>
          ) : (
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-l3">端点预设</span>
              <select
                className={fieldClass}
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
                      models: [],
                      noAuth: false,
                    });
                    setTestResult(null);
                    setFetchError(null);
                    setFetchedModels(null);
                  }
                }}
              >
                <option value="" disabled>
                  选择一个预设…
                </option>
                {PRESETS.filter((p) => p.agent === form.agent).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                    {p.note ? `（${p.note}）` : ""}
                    {p.confidence === "official"
                      ? " · 官方"
                      : p.confidence === "verified-compatible"
                        ? " · 已验证兼容"
                        : p.confidence === "address-only"
                          ? " · 仅填地址"
                          : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-l3">Agent</span>
            <select
              className={fieldClass}
              value={form.agent}
              disabled={!!initial}
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
        </section>

        <section className="mb-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-medium text-l2">连接身份</span>
            <span className="text-micro text-l4">用于在列表和运行页识别</span>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-l3">名称</span>
            <input
              className={fieldClass}
              required
              placeholder="官方 / 中转 A"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
        </section>
        {officialSupported[form.agent] && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs text-l3">账号类型</span>
            <select
              className={fieldClass}
              value={form.accountType}
              onChange={(e) =>
                setForm({
                  ...form,
                  accountType: e.target.value as "api" | "official",
                  noAuth: false,
                })
              }
            >
              <option value="api">API 端点 + 密钥</option>
              <option value="official">官方账号（用 CLI 登录，无需密钥）</option>
            </select>
          </label>
        )}
        {form.accountType === "official" && (
          <p className="-mt-1 mb-3 text-xs text-l3">用 CLI 自己的账号登录，不注入端点与密钥。请先在组内完成连接。</p>
        )}
        {form.accountType === "api" && (
          <label className="mb-3 flex items-center gap-2 text-xs text-l2">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={form.noAuth}
              onChange={(e) => setForm({ ...form, noAuth: e.target.checked })}
            />
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-field bg-canvas text-[10px] text-cta-text transition-colors peer-checked:border-cta-bd peer-checked:bg-cta peer-checked:after:content-['✓']"
            />
            本地端点无密钥（不会继承 shell 中的其他 API Key）
          </label>
        )}
        {form.accountType === "api" && (
          <>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">Base URL（可选）</span>
          <div className="flex gap-2">
            <input
              className={fieldClass}
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
              className={`${rowActionClass} w-20 shrink-0`}
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
            className={fieldClass}
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
              className={`${rowActionClass} shrink-0 whitespace-nowrap`}
            >
              {fetching ? "获取中…" : "获取模型"}
            </button>
            {fetchedModels && fetchedModels.length > 0 && (
              <select
                className={fieldClass}
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
          {/* 空模型是个静默陷阱（pty.rs）：models 为空时**完全不注入**模型环境变量，
              CLI 用自己的默认值——用户看到的现象就是「切了没反应」。API 类配置才提示，
              官方账号本就由 CLI 自己决定模型 */}
          {form.models.length === 0 && form.accountType !== "official" && (
            <p className="mb-2 text-micro text-warn-text">
              没填模型，会用 CLI 自己的默认值。
            </p>
          )}
          {form.models.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.models.map((m, i) => (
                <span
                  key={m}
                  title={(() => {
                    const c = capabilities.find((item) => item.model === m);
                    if (!c) return undefined;
                    const flags = [
                      c.thinking ? "思考" : null,
                      c.tools === true ? "工具" : c.tools === false ? "无工具" : "工具未知",
                      c.vision === true ? "图像" : c.vision === false ? "无图像" : "图像未知",
                    ].filter(Boolean);
                    return `${flags.join(" · ")} · 上下文 ${(c.context / 1024).toFixed(0)}K`;
                  })()}
                  className="flex items-center gap-1 rounded-sm bg-inset px-2 py-0.5 text-xs text-l2"
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
              className={fieldClass}
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
              className={`${rowActionClass} w-16 shrink-0 whitespace-nowrap`}
            >
              添加
            </button>
          </div>
        </div>
        <details className="mb-4 border-t border-hairline pt-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-l2">
            高级设置
          </summary>
          <div className="mt-3">
            {AGENT_PROTOCOLS[form.agent] && (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-xs text-l3">协议</span>
                <select
                  className={fieldClass}
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
                className={`${fieldClass} h-20 font-mono text-xs`}
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
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className={primaryActionClass}
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

/** 各 CLI 断开官方账号的方式（Ccode 不删 auth 文件，引导用 CLI 自己的 logout；
 *  命令按官方文档/CLI help 核实，见 agent_specs.rs 的 official_account 注释） */
const OFFICIAL_LOGOUT_HINT: Record<string, string> = {
  "claude-code": "claude auth logout（或 TUI 内 /logout）",
  codex: "codex logout",
  gemini: "TUI 内 /auth signout",
  codebuddy: "TUI 内 /logout",
  cursor: "cursor-agent logout",
  grok: "grok logout",
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

/** 连接列表五列网格模板：名称 | 域名 | 模型 | 密钥状态 | 操作。
 *  官方账号行与数据行共用同一模板，保证上下行严格垂直对齐；
 *  操作列 170px 刚好容纳「两枚 hover 图标钮 + 编辑 + ⋯」，再宽会在中等窗口把行撑出横向滚动 */
const PROFILE_GRID =
  "grid-cols-[minmax(150px,1.1fr)_minmax(140px,0.9fr)_minmax(150px,1fr)_110px_170px]";

/** 连接状态微型胶囊（Pill Badge）：每行只出一个最高优先级状态
 *  （配置失效 > 已停用 > 已验证 > 未验证），不再多标记堆叠；
 *  「默认」「全局生效」不是健康状态，收进名称下方 caption 行 */
function StatusPill({
  tone,
  tip,
  children,
}: {
  tone: "ok" | "err" | "muted";
  tip: string;
  children: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-ok text-ok-text"
      : tone === "err"
        ? "bg-err text-err-text"
        : "bg-inset text-l4";
  return (
    <span
      className={`ml-1.5 inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-px text-micro font-normal ${cls}`}
      title={tip}
    >
      {children}
    </span>
  );
}

/** 官方账号状态行：与数据行共用同一五列网格与行高（无独立背景/行高），
 *  状态微型标签占「名称」列、操作占「操作」列，保证整列严格对齐；
 *  排查指引（检测路径/登录命令/断开方式）收进悬浮 tooltip，右侧只留连接 + 刷新图标钮。
 *  hook 约束：状态行挂在 per-agent 组件上，useHoverTip 才能逐行实例化。 */
function OfficialStatusRow({
  agentId,
  st,
  onConnect,
  onRefresh,
}: {
  agentId: string;
  st: OfficialAccountStatusDto;
  onConnect: () => void;
  onRefresh: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const { tip, show, hide } = useHoverTip(anchorRef);
  // 悬浮正文：检测说明（含凭证路径）+ 下一步操作引导
  const lines: string[] = [];
  if (st.detail) lines.push(st.detail);
  if (st.connected) {
    const hint = OFFICIAL_LOGOUT_HINT[agentId];
    if (hint) lines.push(`断开方式：${hint}`);
  } else if (st.loginCommand) {
    lines.push(`点「连接」将在终端执行：${st.loginCommand}`);
  }
  return (
    <div
      className={`grid min-h-14 ${PROFILE_GRID} items-center gap-3 border-b border-hairline px-4 text-sm`}
    >
      <span
        ref={anchorRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
        className="flex min-w-0 cursor-default items-center gap-1.5"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.connected ? "bg-ok-text" : "bg-l4"}`}
        />
        <span className={st.connected ? "text-ok-text" : "text-l3"}>
          官方账号 · {st.connected ? "已连接" : "未连接"}
        </span>
      </span>
      {lines.length > 0 && <HoverTip tip={tip} text={lines.join("\n")} />}
      <span />
      <span />
      <span />
      <span className="flex shrink-0 items-center justify-end gap-1">
        {!st.connected && (
          <button
            onClick={onConnect}
            title={`在终端执行 ${st.loginCommand ?? ""}`}
            className={ghostActionClass}
          >
            连接
          </button>
        )}
        <button
          onClick={onRefresh}
          title="重新检测连接状态"
          aria-label="重新检测连接状态"
          className="flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1"
        >
          ⟳
        </button>
      </span>
    </div>
  );
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
    if (/Windows/i.test(navigator.userAgent)) {
      return "Windows 权限不足：请先安装 Node.js LTS 并重新打开 Ccode；若 Node.js 已安装，请确认 npm 全局目录可写，再重试。";
    }
    return "权限不足：该命令需要写入全局目录，检查安装目录权限";
  }
  if (output.includes("命令超时")) {
    return method.includes("npm")
      ? "npm 安装超过 15 分钟仍未完成，已自动终止：请检查 registry/代理设置后重试"
      : "命令超过 15 分钟未完成，已自动终止：通常是下载过慢，重试或检查网络";
  }
  return null;
}

/** Windows 上有官方 winget 包的 agent（与 agent_specs.rs 的 winget 字段同源，新增时同步） */
const WINGET_AGENTS = new Set(["claude-code", "codex", "opencode", "kimi", "grok"]);

function installToolHelp(agentId: string): string {
  if (/Windows/i.test(navigator.userAgent)) {
    if (WINGET_AGENTS.has(agentId)) {
      return "未找到可用的安装工具：winget 与 Node.js 都不可用。该 agent 在 Windows 上有两条路——① 系统自带 winget：若被卸载，请在 Microsoft Store 安装「应用安装程序」；② 安装 Node.js LTS 走 npm 渠道（下载：https://nodejs.org/en/download）。完成后完全退出并重新打开 Ccode。";
    }
    return "未找到可用的安装工具：该 agent 在 Windows 上只能走 npm 渠道。请先安装 Node.js LTS（自带 npm），安装完成后完全退出并重新打开 Ccode 再重试。下载：https://nodejs.org/en/download";
  }
  return "未找到可用的安装工具。请先安装 Node.js（会同时提供 npm），然后完全退出并重新打开 Ccode 再重试。";
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 ccode-fade"
      onClick={onClose}
    >
      <section
        className="w-full max-w-xl rounded-lg border border-field ccode-float-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-l1">
              验证连接 · {profile.name}
            </h2>
            <p className="mt-0.5 text-xs text-l4">
              密钥只在后端用于预检，不会返回界面
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
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

/** 「设为全局」进度/结果弹层：确认后立即弹出（写入 + CLI 复检含网络检查，要几秒到
    十几秒，没反馈像点了没反应）；完成后同层切换为结果视图；验证未通过可一键展开
    三层验证详情（复用 ValidationDialog）。进行中禁关（点遮罩无效、无关闭钮）防误触 */
function GlobalApplyDialog({
  profile,
  running,
  applied,
  error,
  onClose,
  onShowValidation,
}: {
  profile: Profile;
  running: boolean;
  applied: GlobalApplyResultDto | null;
  error: string | null;
  onClose: () => void;
  onShowValidation: () => void;
}) {
  const cli = applied?.validation.cli ?? null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 ccode-fade"
      onClick={running ? undefined : onClose}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-xl rounded-lg border border-field ccode-float-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-l1">
              设为全局 · {profile.name}
            </h2>
            <p className="mt-0.5 text-xs text-l4">
              写入该 CLI 的全局配置文件，任何终端生效；失败自动回滚
            </p>
          </div>
          {!running && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto h-8 rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
            >
              关闭
            </button>
          )}
        </header>
        <div className="px-4 py-3 text-xs leading-5">
          {running ? (
            <p className="text-l3">
              ◌ 正在写入全局配置并做 CLI 复检（含网络检查，可能要几秒到十几秒）…
            </p>
          ) : error ? (
            <p className="break-words text-err-text">{error}</p>
          ) : applied ? (
            <div className="space-y-2">
              <div>
                <p className="font-medium text-l2">已写入全局连接：</p>
                <ul className="mt-1 space-y-0.5 font-mono text-l3">
                  {applied.files.map((f) => (
                    <li key={f} className="break-all">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
              {cli && (
                <p
                  className={`break-words ${
                    cli.status === "passed" ? "text-ok-text" : "text-err-text"
                  }`}
                >
                  CLI 配置检查：{cli.status === "passed" ? "通过" : "未通过"} —{" "}
                  {cli.message}
                </p>
              )}
            </div>
          ) : null}
        </div>
        {!running && (
          <footer className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
            {applied && !applied.validation.ok && (
              <button
                type="button"
                onClick={onShowValidation}
                className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
              >
                查看验证详情
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={onClose}
              className="inline-flex h-7 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-xs font-medium text-cta-text transition-[filter] hover:brightness-110"
            >
              知道了
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}

export default function ProfilesPage({ visible }: { visible: boolean }) {
  const profiles = useAppStore((s) => s.profiles);
  const profileIssues = useAppStore((s) => s.profileIssues);
  const [usageMap, setUsageMap] = useState<Record<string, ProfileUsageDto>>({});
  const [validationMap, setValidationMap] = useState<Record<string, { ok: boolean; checkedAt: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ccode.profileValidation") ?? "{}") as Record<string, { ok: boolean; checkedAt: string }>;
    } catch {
      return {};
    }
  });

  function rememberValidation(profileId: string, result: ProfileValidationDto) {
    const next = { ...validationMap, [profileId]: { ok: result.ok, checkedAt: result.checkedAt } };
    setValidationMap(next);
    try {
      localStorage.setItem("ccode.profileValidation", JSON.stringify(next));
    } catch {
      /* localStorage unavailable: current view still shows the result */
    }
  }
  const [usagePop, setUsagePop] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);
  // 组头「! N 项连接冲突」胶囊的点击弹层（锚定 agent 分组头）
  const [conflictPop, setConflictPop] = useState<{
    x: number;
    y: number;
    agentId: string;
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

  // 悬浮卡（用量 / 连接冲突）：Escape / 任意滚动即关闭（同 ContextMenu；滚动关闭也避免与锚点脱离）
  useEffect(() => {
    if (!usagePop && !conflictPop) return;
    const closeAll = () => {
      setUsagePop(null);
      setConflictPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    // capture 阶段的滚动监听能捕获任意容器的滚动
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", closeAll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", closeAll, true);
    };
  }, [usagePop, conflictPop]);
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

  async function clearAccountConflicts(agentId: string) {
    const st = officialStatus[agentId];
    if (!st?.cleanupSupported) return;
    if (!(await confirmDialog(`只移除 ${labelOf(agentId)} 已识别的 API 环境项，并保留其他配置。继续？`, { danger: true })))
      return;
    try {
      const files = await invoke<string[]>("clear_account_conflicts", { agentId });
      await refreshOfficial(agentId);
      setNotice(files.length ? `已清理：${files.join("、")}` : "没有可清理的已识别冲突项");
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setError(String(e));
    }
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
  // 「复制到其他 agent…」二级菜单（#14）：点 rowMenu 项后替换弹出，列出同协议族目标
  const [copyMenu, setCopyMenu] = useState<{
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
  // 操作成功提示（复制到其他 agent 等），几秒后自动消失
  const [notice, setNotice] = useState<string | null>(null);
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
  // 「首次写入前」原始快照（永久保留）：控制「恢复初始状态」入口显隐
  const [originalBackups, setOriginalBackups] = useState<Record<string, boolean>>(
    {},
  );
  // 公共模型能力库（models.dev/OpenRouter 下载）状态：顶部 ⋯ 菜单的下载/更新入口
  const [modelDb, setModelDb] = useState<{
    downloaded: boolean;
    models: number;
    downloadedAt?: string | null;
  } | null>(null);
  useEffect(() => {
    invoke<{
      downloaded: boolean;
      models: number;
      downloadedAt?: string | null;
    }>("model_db_status")
      .then(setModelDb)
      .catch(() => {});
  }, []);

  /** 下载/更新公共模型能力库：下载后接入的模型自动带上正确的上下文/输出/视觉/推理声明 */
  async function onModelDbDownload() {
    try {
      const s = await invoke<{
        downloaded: boolean;
        models: number;
        downloadedAt?: string | null;
      }>("download_model_db");
      setModelDb(s);
      setNotice(`模型能力库已就绪：${s.models} 个模型`);
      setTimeout(() => setNotice(null), 4000);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
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

  async function refreshUpdateInfo(force = false) {
    try {
      const list = await invoke<AgentUpdateInfo[]>("check_agent_updates", {
        force,
      });
      setUpdateInfo(Object.fromEntries(list.map((i) => [i.id, i])));
    } catch {
      /* 检查失败（网络等）不影响页面 */
    }
  }
  // 交互式自更新（kimi upgrade 等）路由到终端执行，绕过后端的缓存失效链路：
  // 记下待重查标记，回切本页时 force 刷新（页面在 App.tsx 保持挂载，不会重新 mount）
  const interactiveUpdateLaunchedRef = useRef(false);
  const visibleRef = useRef(visible);
  useEffect(() => {
    const was = visibleRef.current;
    visibleRef.current = visible;
    if (!visible || was) return;
    if (interactiveUpdateLaunchedRef.current) {
      interactiveUpdateLaunchedRef.current = false;
      void (async () => {
        await refreshUpdateInfo(true);
        await loadAll();
      })();
    } else {
      // 未标记的回切也顺手刷一次：后端缓存有 2 分钟 TTL，未过期时是纯缓存命中
      void refreshUpdateInfo();
    }
  }, [visible]);
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
      interactiveUpdateLaunchedRef.current = true;
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
        setError(installToolHelp(agentId));
        return;
      }
      if (
        !(await confirmDialog(
          `将通过以下命令安装 ${labelOf(agentId)}：\n\n${method}\n\n继续？`,
        ))
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

  /** 每个 agent 是否有可恢复的完整全局配置批次（控制「恢复备份」按钮显隐）；
      顺带查「首次写入前」原始快照（控制「恢复初始状态」入口显隐） */
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
    const originals = await Promise.all(
      AGENTS.map(
        async (a) =>
          [
            a.id,
            await invoke<boolean>("has_original_backup", { agent: a.id }),
          ] as const,
      ),
    );
    setOriginalBackups(Object.fromEntries(originals));
  }

  useEffect(() => {
    refreshGlobalBackups().catch(() => {});
  }, [profiles]);

  /** 能力表（agent_capabilities）：「设为全局」按 setGlobal 置灰 + 原因提示，与后端报错同源 */
  const [caps, setCaps] = useState<Record<string, AgentCapabilitiesDto>>({});
  useEffect(() => {
    invoke<AgentCapabilitiesDto[]>("agent_capabilities")
      .then((list) =>
        setCaps(Object.fromEntries(list.map((c) => [c.agent, c]))),
      )
      .catch(() => {});
  }, []);

  /** 三层验证结果镜像进 store（收件箱「配置失效」条目）；通过则摘除。原因取第一个未通过层 */
  function mirrorValidation(p: Profile, result: ProfileValidationDto) {
    const layers: [string, ValidationCheckDto][] = [
      ["本地解析", result.local],
      ["CLI 预检", result.cli],
      ["API 连通", result.api],
    ];
    const failed = layers.find(([, c]) => c.status === "failed");
    useAppStore.getState().setProfileIssue(
      p.id,
      failed
        ? { name: p.name, agent: p.agent, reason: `${failed[0]}：${failed[1].message}` }
        : null,
    );
  }

  /** 把 profile 事务化写入该 CLI 的全部目标文件，UI 明示影响范围 */
  async function onApplyGlobal(p: Profile) {
    if (applyDialog) return; // 已有写入在进行/结果在展示，禁止重入
    if (
      !(await confirmDialog(
        `将把该连接写入 ${labelOf(p.agent)} 的全局配置文件（影响其他终端里的使用）。全部文件会作为一个批次写入，失败会自动回滚；当前内容会先备份。继续？`,
      ))
    )
      return;
    // 确认后立刻弹进度层：写文件 + doctor 复检要几秒到十几秒，静默等待像没反应
    setApplyDialog({ profile: p, running: true, applied: null, error: null });
    try {
      const applied = await invoke<GlobalApplyResultDto>(
        "apply_profile_global",
        {
          profileId: p.id,
        },
      );
      await refreshGlobalBackups();
      // 后端已把该连接记为「全局生效」（settings.activeGlobalProfiles），重拉设置刷新徽标
      await loadSettings();
      mirrorValidation(p, applied.validation);
      rememberValidation(p.id, applied.validation);
      setApplyDialog({ profile: p, running: false, applied, error: null });
      setError(null);
    } catch (e) {
      setApplyDialog({
        profile: p,
        running: false,
        applied: null,
        error: String(e),
      });
    }
  }

  async function onValidate(p: Profile) {
    setValidationDialog({ profile: p, result: null, running: true });
    try {
      const result = await invoke<ProfileValidationDto>("validate_profile", {
        profileId: p.id,
      });
      mirrorValidation(p, result);
      rememberValidation(p.id, result);
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
      !(await confirmDialog(
        `将恢复 ${labelOf(agentId)} 最近一个完整备份批次。当前状态会先另存为新备份，原恢复点不会被消耗。继续？`,
      ))
    )
      return;
    try {
      const files = await invoke<string[]>("restore_global_backup", {
        agent: agentId,
      });
      await refreshGlobalBackups();
      // 恢复后全局内容不再是任何连接的快照，后端已清「全局生效」标记，重拉设置刷新徽标
      await loadSettings();
      await alertDialog(
        files.length
          ? `已恢复完整批次：\n${files.join("\n")}`
          : "没有可恢复的完整备份批次",
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 恢复到「Ccode 首次写入前」的原始状态（永久快照，不参与批次轮换）。
      当前状态会先存成常规批次，恢复后想反悔可再点「恢复备份」 */
  async function onRestoreOriginal(agentId: string) {
    if (
      !(await confirmDialog(
        `将把 ${labelOf(agentId)} 的全局配置恢复到 Ccode 首次写入前的原始状态（Ccode 当时新建的文件会被删除）。当前状态会先另存为新备份，可用「恢复备份」反悔。继续？`,
      ))
    )
      return;
    try {
      const files = await invoke<string[]>("restore_original_backup", {
        agent: agentId,
      });
      await refreshGlobalBackups();
      // 后端已清「全局生效」标记，重拉设置刷新徽标
      await loadSettings();
      await alertDialog(
        files.length
          ? `已恢复首次写入前的原始状态：\n${files.join("\n")}`
          : "首次写入前没有任何目标文件，已全部清除",
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
      await alertDialog(`已导入 ${added} 个连接（密钥需逐个补填）`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(p: Profile) {
    if (
      !(await confirmDialog(`删除连接「${p.name}」？本地受限存储的密钥会一并删除。`, {
        danger: true,
      }))
    )
      return;
    try {
      await removeProfile(p.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClearKey(p: Profile) {
    if (!(await confirmDialog(`清除连接「${p.name}」的本地密钥？之后需要重新填写才可启动。`, { danger: true })))
      return;
    try {
      await invoke("clear_profile_key", { id: p.id });
      await loadAll();
      setNotice(`已清除「${p.name}」的本地密钥`);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 复制到其他 agent（#14）：密钥在后端 0600 文件内直读直写，不经前端；成功后刷新列表并提示 */
  async function onCopyToAgent(p: Profile, targetAgent: string) {
    try {
      const created = await invoke<Profile>("copy_profile_to_agent", {
        profileId: p.id,
        targetAgent,
      });
      await loadAll();
      setNotice(`已复制连接到 ${labelOf(targetAgent)}：「${created.name}」`);
      setTimeout(() => setNotice(null), 4000);
      setError(null);
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
  // 保存后的「要重启标签才生效」提示（仅当该 agent 确有标签在跑）
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // 「设为全局」进度/结果弹层：确认后立即弹出（写文件 + CLI 复检含网络检查要几秒到
  // 十几秒，没反馈像点了没反应）；非 null 期间禁止重入
  const [applyDialog, setApplyDialog] = useState<{
    profile: Profile;
    running: boolean;
    applied: GlobalApplyResultDto | null;
    error: string | null;
  } | null>(null);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const loadSettings = useAppStore((s) => s.loadSettings);

  /** 「在终端使用」：新开标签并直接启动（与快速开聊共用 pendingTerminal 链路）。
   *  目录取上次启动过的，没有就交给启动栏留空由用户填 */
  function useTerminalWith(profile: Profile) {
    let cwd = "";
    try {
      cwd =
        (JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as {
          cwd?: string;
        }).cwd ?? "";
    } catch {
      /* 读不到就留空 */
    }
    setPendingTerminal({
      cwd,
      extraEnv: {},
      agentId: profile.agent,
      profileId: profile.id,
      autoStart: !!cwd,
    });
    setPage("terminal");
  }

  async function useExternalWith(profile: Profile) {
    let cwd = "";
    try {
      cwd =
        (JSON.parse(localStorage.getItem("ccode.lastLaunch") ?? "{}") as { cwd?: string }).cwd ?? "";
    } catch {
      /* 损坏的本地记忆不阻断外部启动 */
    }
    if (!cwd.trim()) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") cwd = picked;
    }
    if (!cwd.trim()) return;
    try {
      await invoke("new_external_terminal", {
        agentId: profile.agent,
        cwd,
        profileId: profile.id,
        model: profile.models[0] ?? null,
      });
      setNotice(`已在外部终端启动「${profile.name}」`);
      setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 停用/取消停用（settings.hiddenProfiles 整表覆盖；字段名沿用旧称不改存储）：
      软停用 = 不被自动路径挑中（启动栏预选/兜底、恢复会话、AI 功能回落），
      手动指定仍可用——启动栏下拉里沉到「已停用」分组可手选 */
  async function toggleHiddenProfile(profile: Profile) {
    const cur = new Set(settings?.hiddenProfiles ?? []);
    if (cur.has(profile.id)) cur.delete(profile.id);
    else cur.add(profile.id);
    await updateSettings({ hiddenProfiles: [...cur] });
  }

  /** 设为该 agent 的默认配置（settings.defaultProfiles 整图覆盖；再点一次取消） */
  async function toggleDefaultProfile(profile: Profile) {
    const cur = { ...(settings?.defaultProfiles ?? {}) };
    if (cur[profile.agent] === profile.id) delete cur[profile.agent];
    else cur[profile.agent] = profile.id;
    await updateSettings({ defaultProfiles: cur });
  }
  const liveSessions = useAppStore((s) => s.liveSessions);
  const runningAgents = new Set(
    Object.keys(liveSessions).map((k) => k.split("\n")[0]),
  );

  return (
    <div className="min-h-full bg-canvas">
      <PageFrame width="fluid">
        {/* 注入模式的核心规则：配置只在**启动那一刻**注入子进程，改了对已在跑的标签无效。
            这条以前只写在用户手册里，用户改完配置回终端发现没变化，界面上没有任何解释
            （「有时候配置了无法切换模型」的第二个来源）。保存后有标签在跑才提示，平时不啰嗦。 */}
        {savedNote && (
          <NoticeBar tone="warn" onDismiss={() => setSavedNote(null)}>
            {savedNote}
          </NoticeBar>
        )}
        {/* 命令栏：标题 + 元信息，右侧动作 */}
        <PageHeader
          title="连接"
          meta={`Agent、供应商与模型 · ${profiles.length} 个连接`}
          actions={
            <>
              <button
                type="button"
                onClick={() => setModal({ initial: null })}
                className={primaryActionClass}
              >
                + 添加连接
              </button>
              <button
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTopMenu({ x: rect.right - 176, y: rect.bottom + 4 });
                }}
                title="更多连接操作"
                aria-label="更多连接操作"
                className="flex h-8 w-8 items-center justify-center rounded-sm text-sm text-l2 hover:bg-hover hover:text-l1"
              >
                ⋯
              </button>
            </>
          }
        />

        {/* 过滤条：状态筛选胶囊（选中=实心 seg-sel）+ 右侧搜索框 */}
        <PageToolbar>
          <div className="flex items-center gap-1">
            <SegTabs
              items={(
                [
                  ["all", "全部"],
                  ["installed", "已安装"],
                  ["uninstalled", "未安装"],
                ] as const
              ).map(([id, label]) => ({ id, label }))}
              value={statusFilter}
              onChange={setStatusFilter}
            />
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
              className="ml-2 flex h-7 items-center rounded-sm px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
            >
              {anyExpanded ? "全部折叠" : "全部展开"}
            </button>
          </div>
          {/* 搜索框：inset 底 + hairline 细边（同对话页手法） */}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索连接 / 端点 / 模型"
            className={`${searchFieldClass} w-56`}
          />
        </PageToolbar>

        {error && <p className="mt-4 text-sm text-err-text">{error}</p>}
        {notice && <p className="mt-4 text-xs text-ok-text">{notice}</p>}

        {/* agent 分组（可折叠） */}
        <div>
          {visibleAgents.map((agent) => {
            const det = agents.find((a) => a.id === agent.id);
            const list = profiles.filter(
              (p) => p.agent === agent.id && matchProfile(p),
            );
            const connectionCount = profiles.filter(
              (p) => p.agent === agent.id,
            ).length;
            if (q && list.length === 0) return null;
            const isCollapsed = collapsedGroups.has(agent.id);
            // 分组卡片化（v3.93 用户拍板）：field 细边 + strip 底色卡片给每个 agent 明确边界，
            // 替代原 hairline + 左侧缩进线手法；未安装的卡片去底色降权（无配置可管，权重最低）。
            // 不用 opacity 降权：opacity<1 会改变 fixed 后代的包含块，悬浮层定位会错乱。
            const installed = !!det?.binaryPath;
            return (
              <section
                key={agent.id}
                className={`mb-4 overflow-hidden rounded-md border ${
                  installed
                    ? "border-field bg-strip"
                    : "border-hairline"
                }`}
              >
                <div className="group flex h-11 items-center gap-2 px-3">
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
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-l2 hover:bg-hover hover:text-l1"
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </button>
                  <h2 className="text-sm font-medium text-l1">
                    {agent.label}
                  </h2>
                  <span className="rounded-full bg-inset px-1.5 py-0.5 text-micro text-l4">
                    {connectionCount} 个连接
                  </span>
                  {/* 连接冲突提升为组头琥珀胶囊（v3.93）：CLI 自读文件里的残留密钥会覆盖官方账号
                      登录并产生计费——藏在大段灰字里会被忽略；点击弹层列出具体文件/变量 */}
                  {(officialStatus[agent.id]?.conflicts.length ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        setConflictPop({
                          x: rect.left,
                          y: rect.bottom + 4,
                          agentId: agent.id,
                        });
                      }}
                      title="本地配置文件中的残留密钥会覆盖官方账号登录，点击查看明细"
                      className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-warn px-2 text-micro text-warn-text transition-[filter] hover:brightness-125"
                    >
                      ! {officialStatus[agent.id].conflicts.length} 项连接冲突
                    </button>
                  )}
                  {/* 已安装显示包名+版本号（mono micro 灰字，弱化技术参数）；右侧状态：更新中… / 新版（可点更新）/ 更新（查不到最新版时的回退）；已是最新则不显示 */}
                  {det?.binaryPath ? (
                    <span className="font-mono text-micro text-l4">
                      {agent.binary} {det.version ?? ""}
                    </span>
                  ) : (
                    <span className="text-xs text-l2">
                      未安装（<span className="font-mono">{agent.binary}</span>{" "}
                      不在 PATH）
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setModal({ initial: null, presetAgent: agent.id })
                      }
                      className={rowActionClass}
                    >
                      + 添加连接
                    </button>
                    {det?.binaryPath ? (
                    (() => {
                      if (updating[agent.id])
                        return (
                          <span className="text-xs text-l2">
                            更新中…
                          </span>
                        );
                      const info = updateInfo[agent.id];
                      const tuiPrefill = interactiveUpdatePrefill(info);
                      if (updateResults[agent.id]?.ok) return null;
                      if (info && !info.outdated && info.latest) {
                        // brew 已最新但上游 npm 更高（渠道滞后边角场景）：不再常驻一串小字
                        // 挤组头，收成一枚安静的 ⧉ 图标钮——tooltip 承载完整说明，点击复制渠道切换命令
                        const note = upstreamNoteText(info);
                        const cmd = upstreamCommand(info);
                        if (!note || !cmd) return null;
                        return (
                          <button
                            type="button"
                            title={`${note}\n点击复制渠道切换命令：${cmd}\n含义：卸载 brew 版本并改装 npm 版本（之后更新走 npm 渠道，Ccode 自动按 npm 检查）`}
                            onClick={() =>
                              void navigator.clipboard.writeText(cmd)
                            }
                            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-l4 transition-colors hover:bg-hover hover:text-cta"
                          >
                            ⧉
                          </button>
                        );
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
                            className="flex h-8 items-center rounded-sm px-2 text-xs text-cta hover:bg-hover hover:brightness-125"
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
                          className="flex h-8 items-center rounded-sm px-2 text-xs text-l2 hover:bg-hover hover:text-l1"
                        >
                          更新
                        </button>
                      );
                    })()
                  ) : (
                    <button
                      onClick={() => onInstall(agent.id)}
                      disabled={updating[agent.id]}
                      className={`${secondaryActionClass} px-2.5`}
                    >
                      {updating[agent.id] ? "安装中…" : "安装"}
                    </button>
                    )}
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="border-t border-hairline">
                    {/* 官方账号状态行（P1a）：支持官方账号的 agent 固定展示；断开走 CLI 自己的 logout，Ccode 不删 auth 文件 */}
                    {officialStatus[agent.id]?.supported && (
                      <OfficialStatusRow
                        agentId={agent.id}
                        st={officialStatus[agent.id]}
                        onConnect={() => connectOfficial(agent.id)}
                        onRefresh={() => void refreshOfficial(agent.id)}
                      />
                    )}
                    {/* 安装/更新实时输出（全宽，行为不变） */}
                    {updating[agent.id] && (
                      <div className="mx-3 mt-2">
                        <pre
                          // callback ref：每次渲染都把滚动条钉在底部，实现跟随输出自动滚动
                          ref={(el) => {
                            if (el) el.scrollTop = el.scrollHeight;
                          }}
                          className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-t border border-hairline border-b-0 bg-canvas p-2 font-mono text-xs text-l2"
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
                        <div className="flex items-center gap-1.5 rounded-b border border-hairline bg-canvas px-2 py-1.5">
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
                            className="flex-1 bg-transparent font-mono text-xs text-l2 outline-none placeholder:text-l4"
                          />
                        </div>
                      </div>
                    )}
                    {updateResults[agent.id] && (
                      <div className="mx-3 mt-2 rounded-sm bg-inset p-2 text-xs text-l2">
                        <span
                          className={
                            updateResults[agent.id].ok
                              ? "text-ok-text"
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
                      // 空状态虚线引导框（v3.93）：整框即「+ 添加配置」按钮，强化可点击创建的暗示；
                      // 分组内小区块虚线，不属于被否决的大面积页面级虚线空状态
                      <div className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() =>
                            setModal({ initial: null, presetAgent: agent.id })
                          }
                          className="flex h-12 w-full items-center justify-center rounded-md border border-dashed border-field text-xs text-l3 transition-colors hover:border-l4 hover:bg-inset hover:text-l1"
                        >
                          + 添加连接
                        </button>
                      </div>
                    ) : (
                      // 行间极细分割线（hairline）替代卡片间距：整列垂直严格对齐，视觉节奏与官方账号行一致
                      <ul className="divide-y divide-hairline overflow-x-auto">
                        {list.map((profile) => {
                          const hidden = (
                            settings?.hiddenProfiles ?? []
                          ).includes(profile.id);
                          const isDefault =
                            settings?.defaultProfiles?.[profile.agent] ===
                            profile.id;
                          const isGlobal =
                            settings?.activeGlobalProfiles?.[profile.agent] ===
                            profile.id;
                          const verified =
                            validationMap[profile.id]?.ok === true;
                          // caption 行（名称下方次级辅助文本）：上次使用 · 默认 · 全局生效
                          const caption: {
                            text: string;
                            tip: string;
                            cls?: string;
                          }[] = [];
                          if (profile.lastUsedAt)
                            caption.push({
                              text: `上次使用 ${relTime(profile.lastUsedAt)}`,
                              tip: `上次使用 ${absTime(profile.lastUsedAt)}`,
                            });
                          if (isDefault)
                            caption.push({
                              text: "默认",
                              tip: "终端启动栏选这个 agent 时默认使用",
                            });
                          // 「设为全局」追踪标记：只代表上次由 Ccode 写入全局配置，
                          // 外部手改配置文件后会失真——tip 照实说明，不声称绝对生效
                          if (isGlobal)
                            caption.push({
                              text: "全局生效",
                              tip: "上次由 Ccode 写入该 agent 的全局配置：外部终端/其他工具里的该 CLI 用这套。在 Ccode 之外手改配置文件后此标记可能失真",
                              cls: "text-ok-text",
                            });
                          return (
                          <li
                            key={profile.id}
                            className={`group grid min-h-14 ${PROFILE_GRID} items-center gap-3 px-4 text-sm transition-colors hover:bg-hover/60`}
                          >
                            <span className="min-w-0">
                              <span
                                className="block truncate font-medium text-l1"
                                title={profile.name}
                              >
                                {profile.name}
                                {profileIssues[profile.id] ? (
                                  <StatusPill tone="err" tip={profileIssues[profile.id].reason}>配置失效</StatusPill>
                                ) : hidden ? (
                                  <StatusPill tone="muted" tip="已停用：不会被恢复会话和 AI 功能自动挑中；启动栏下拉里沉到「已停用」分组，仍可手选">已停用</StatusPill>
                                ) : verified ? (
                                  <StatusPill tone="ok" tip={`最近验证 ${validationMap[profile.id].checkedAt}`}>已验证</StatusPill>
                                ) : (
                                  <StatusPill tone="muted" tip="尚未验证；行尾 ⋯ 菜单可手动「验证」">未验证</StatusPill>
                                )}
                              </span>
                              {/* caption 行：micro 档灰字，相对时间主显、悬浮给绝对时间（白话双层） */}
                              {caption.length > 0 && (
                                <span className="mt-0.5 block truncate text-micro text-l4">
                                  {caption.map((c, i) => (
                                    <span key={c.text} title={c.tip} className={c.cls}>
                                      {i > 0 ? " · " : ""}
                                      {c.text}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                            <span
                              className={`min-w-0 truncate text-xs ${profile.baseUrl || profile.accountType === "official" ? "text-l2" : "text-l4"}`}
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
                            {/* 模型列轻量化：mono micro 纯文字（不套底色块），前 3 个平铺，其余折叠为 +N；
                                列宽装不下时 overflow 裁切，悬浮 title 始终给全文 */}
                            <span
                              className="flex min-w-0 items-center gap-1.5 overflow-hidden"
                              title={
                                profile.models.length > 0
                                  ? profile.models.join(" · ")
                                  : undefined
                              }
                            >
                              {profile.models.length > 0 ? (
                                <>
                                  {profile.models.slice(0, 3).map((m) => (
                                    <span
                                      key={m}
                                      className="shrink-0 font-mono text-micro text-l3"
                                    >
                                      {m}
                                    </span>
                                  ))}
                                  {profile.models.length > 3 && (
                                    <span className="shrink-0 font-mono text-micro text-l4">
                                      +{profile.models.length - 3}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-xs text-l4">
                                  未指定模型
                                </span>
                              )}
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
                                profile.hasKey ? "text-ok-text" : "text-l2"
                              }`}
                              title={
                                profile.hasKey
                                  ? `密钥已受限存储${profile.keyHint ? `（${profile.keyHint}）` : ""}`
                                  : "尚未填写密钥"
                              }
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${
                                  profile.hasKey ? "bg-ok-text" : "bg-l4"
                                }`}
                              />
                              {profile.hasKey ? "已保存密钥" : "未设置"}
                            </span>
                            )}
                            <span className="flex items-center justify-end gap-1 whitespace-nowrap">
                              {/* 「在终端使用」（v3.88）：配置页原本没有任何通往终端的路——
                                  建完配置只能自己去终端页再选一遍。
                                  低频入口 = hover 才现的 28px 图标 ghost 钮（常驻位只留「编辑」），
                                  操作列才塞得下、行高不被撑乱 */}
                              <button
                                type="button"
                                onClick={() => useTerminalWith(profile)}
                                title="在终端使用：用这个连接新开一个终端标签"
                                aria-label={`在终端使用：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                <SquareTerminal size={14} strokeWidth={1.8} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void useExternalWith(profile)}
                                title="外部终端：用这个连接在外部终端新开会话"
                                aria-label={`外部终端打开：${profile.name}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-l3 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                <SquareArrowOutUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setModal({ initial: profile })}
                                className={ghostActionClass}
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
                                className={`flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                              >
                                ⋯
                              </button>
                            </span>
                          </li>
                          );
                        })}
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
            className="absolute w-56 rounded-md border border-field ccode-float-surface p-3 text-xs"
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
                  <div className="mb-1 font-medium text-l1">
                    用量 / 费用（官方价）
                  </div>
                  <div className="flex justify-between py-0.5 text-l2">
                    <span>输入</span>
                    <span>{fmtTokens(u.input)}</span>
                  </div>
                  <div className="flex justify-between py-0.5 text-l2">
                    <span>输出</span>
                    <span>{fmtTokens(u.output)}</span>
                  </div>
                  <div className="flex justify-between py-0.5 text-l2">
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
      {/* 连接冲突弹层：组头琥珀胶囊点出，列出具体文件/变量；只含文件名与变量名，密钥值不出后端 */}
      {conflictPop &&
        (() => {
          const st = officialStatus[conflictPop.agentId];
          if (!st || st.conflicts.length === 0) return null;
          return (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setConflictPop(null)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute w-80 rounded-md border border-field ccode-float-surface p-3 text-xs"
                // 防出屏：往左/往上收（卡片 w-80 约 320px、高约 180px）
                style={{
                  left: Math.max(
                    8,
                    Math.min(conflictPop.x, window.innerWidth - 336),
                  ),
                  top: Math.max(
                    8,
                    Math.min(conflictPop.y, window.innerHeight - 190),
                  ),
                }}
              >
                <div className="mb-1.5 font-medium text-warn-text">
                  ! {st.conflicts.length} 项连接冲突 ·{" "}
                  {labelOf(conflictPop.agentId)}
                </div>
                <ul className="space-y-1">
                  {st.conflicts.map((c) => (
                    <li
                      key={c}
                      className="rounded-sm bg-inset px-1.5 py-1 font-mono text-l2"
                    >
                      {c}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 leading-5 text-l3">
                  这些文件里残留的密钥会覆盖官方账号登录并产生 API
                  计费；请编辑对应文件删除后，点状态行的 ⟳ 重新检测。
                </p>
                {st.cleanupSupported && (
                  <button
                    type="button"
                    className="mt-2 rounded-sm border border-warn-bd bg-warn px-2 py-1 text-xs text-warn-text hover:brightness-110"
                    onClick={() => void clearAccountConflicts(conflictPop.agentId)}
                  >
                    备份后清理已识别项
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      {modal && (
        <ProfileModal
          initial={modal.initial}
          presetAgent={modal.presetAgent}
          officialSupported={Object.fromEntries(
            Object.entries(officialStatus).map(([k, v]) => [k, v.supported]),
          )}
          onClose={() => setModal(null)}
          onSaved={(agent, name) => {
            // 注入模式：改动只对**新启动**的标签生效，已在跑的要重开
            if (runningAgents.has(agent))
              setSavedNote(
                `已保存「${name}」。这个 agent 有终端标签正在运行——连接是在启动那一刻注入的，改动要**重开标签**才生效。`,
              );
          }}
        />
      )}
      {topMenu && (
        <ContextMenu
          x={topMenu.x}
          y={topMenu.y}
          onClose={() => setTopMenu(null)}
          items={[
            { label: "导入连接", onSelect: () => void onImport() },
            { label: "导出连接", onSelect: () => void onExport() },
            {
              label: modelDb?.downloaded
                ? `更新模型能力库（已有 ${modelDb.models} 个模型）`
                : "下载模型能力库（models.dev）",
              title:
                "第三方模型的能力声明（上下文/输出上限/视觉/推理）公共数据源；下载后接入模型自动带正确声明。表单里点「获取模型」时也会顺带沉淀网关实测数据",
              onSelect: () => void onModelDbDownload(),
            },
          ]}
        />
      )}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={[
            {
              // 「停用」的准确形态（软停用）：不动数据、不动启动行为，只让自动路径
              // （启动栏预选/兜底、恢复会话、AI 功能回落）不再挑中它；手动指定仍可用。
              // 真正的「禁用」在注入模式下无意义——配置只在启动那一刻生效，
              // 没被选中的配置本来就不产生任何作用
              label: (settings?.hiddenProfiles ?? []).includes(rowMenu.profile.id)
                ? "取消停用"
                : "停用此连接",
              title:
                "不再被恢复会话和 AI 功能自动挑中；启动栏下拉里沉到「已停用」分组，仍可手选",
              onSelect: () => void toggleHiddenProfile(rowMenu.profile),
            },
            {
              // 用户要的「启用」其实是这个：注入模式没有全局激活态，
              // 能表达的是「这个 agent 默认用哪套」（启动栏据此预选）
              label:
                settings?.defaultProfiles?.[rowMenu.profile.agent] ===
                rowMenu.profile.id
                  ? "取消默认"
                  : "设为该 agent 默认",
              title: "终端启动栏选完这个 agent 后自动预选该配置",
              onSelect: () => void toggleDefaultProfile(rowMenu.profile),
            },
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
              label: "复制连接",
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
            {
              label: "复制到其他 agent…",
              onSelect: () =>
                // rowMenu 已随本次点击关闭，二级菜单在同一锚点弹出
                setCopyMenu({
                  x: rowMenu.x,
                  y: rowMenu.y,
                  profile: rowMenu.profile,
                }),
            },
            { label: "验证", onSelect: () => void onValidate(rowMenu.profile) },
            ...(rowMenu.profile.accountType === "api" && rowMenu.profile.hasKey
              ? [{ label: "清除本地密钥", onSelect: () => void onClearKey(rowMenu.profile) }]
              : []),
            {
              label: "设为全局",
              disabled:
                rowMenu.profile.accountType === "official" ||
                rowMenu.profile.noAuth ||
                (caps[rowMenu.profile.agent] !== undefined &&
                  !caps[rowMenu.profile.agent].setGlobal.supported),
              title:
                rowMenu.profile.accountType === "official"
                  ? "官方账号不写入全局配置"
                  : rowMenu.profile.noAuth
                    ? "无密钥连接不写入全局配置"
                    : (caps[rowMenu.profile.agent]?.setGlobal.reason ??
                      "写入该 agent 的全局配置文件（先备份、失败自动回滚）；成功后此连接标记「全局生效」，供外部终端使用"),
              onSelect: () => void onApplyGlobal(rowMenu.profile),
            },
            ...(globalBackups[rowMenu.profile.agent]
              ? [
                  {
                    label: "恢复备份",
                    title: "恢复最近一次写入前的状态",
                    onSelect: () => void onRestoreBackup(rowMenu.profile.agent),
                  },
                ]
              : []),
            ...(originalBackups[rowMenu.profile.agent]
              ? [
                  {
                    label: "恢复初始状态",
                    title:
                      "恢复到 Ccode 首次写入前的原始配置（永久快照，连续多次设为全局也回得去）",
                    onSelect: () => void onRestoreOriginal(rowMenu.profile.agent),
                  },
                ]
              : []),
            { label: "删除", onSelect: () => void onDelete(rowMenu.profile) },
          ]}
        />
      )}
      {copyMenu && (
        <ContextMenu
          x={copyMenu.x}
          y={copyMenu.y}
          onClose={() => setCopyMenu(null)}
          items={copyTargets(
            copyMenu.profile.agent,
            copyMenu.profile.protocol,
          ).map((t) => ({
            label: t.label,
            disabled: !t.compatible,
            title: t.reason,
            onSelect: () => void onCopyToAgent(copyMenu.profile, t.id),
          }))}
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
      {applyDialog && (
        <GlobalApplyDialog
          profile={applyDialog.profile}
          running={applyDialog.running}
          applied={applyDialog.applied}
          error={applyDialog.error}
          onClose={() => {
            if (!applyDialog.running) setApplyDialog(null);
          }}
          onShowValidation={() => {
            // 「查看验证详情」：进度/结果层换三层验证层（同一份 validation 数据）
            if (applyDialog.applied) {
              setValidationDialog({
                profile: applyDialog.profile,
                result: applyDialog.applied.validation,
                running: false,
              });
            }
            setApplyDialog(null);
          }}
        />
      )}
    </div>
  );
}
