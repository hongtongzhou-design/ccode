import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { AGENTS, AGENT_PROTOCOLS } from "../types";
import { PRESETS } from "../presets";
import type { Profile, ProfileInput } from "../types";

function ProfileModal({
  initial,
  onClose,
}: {
  initial: Profile | null;
  onClose: () => void;
}) {
  const saveProfile = useAppStore((s) => s.saveProfile);
  const [form, setForm] = useState({
    agent: initial?.agent ?? "claude-code",
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
    "w-full rounded border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500";

  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-96 rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-base font-semibold">
          {initial ? "编辑配置" : "新建配置"}
        </h2>
        <div className="mb-4">
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
        </div>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600">Agent</span>
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
        {AGENT_PROTOCOLS[form.agent] && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-neutral-600">协议</span>
            <select
              className={field}
              value={form.protocol ?? AGENT_PROTOCOLS[form.agent].default}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
            >
              {AGENT_PROTOCOLS[form.agent].options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600">名称</span>
          <input
            className={field}
            required
            placeholder="官方 / 中转 A"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="mb-1 block text-sm">
          <span className="mb-1 block text-neutral-600">Base URL（可选）</span>
          <input
            className={field}
            placeholder="https://api.example.com"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
        </label>
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={testConnection}
            disabled={testing || !form.baseUrl.trim()}
            title={form.baseUrl.trim() ? "验证端点与密钥连通性" : "先填写 Base URL"}
            className="shrink-0 rounded border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          {testResult && (
            <span className={`text-xs ${testResult.ok ? "text-green-700" : "text-red-600"}`}>
              {testResult.text}
            </span>
          )}
        </div>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600">API Key</span>
          <input
            className={field}
            type="password"
            autoComplete="new-password"
            placeholder={initial ? "留空则不修改" : "存入系统钥匙串，不回显"}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </label>
        <div className="mb-4 text-sm">
          <span className="mb-1 block text-neutral-600">
            模型列表（可选，首个为默认）
          </span>
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={fetchModels}
              disabled={fetching || !form.baseUrl.trim()}
              title={form.baseUrl.trim() ? "从 Base URL 拉取可用模型" : "先填写 Base URL"}
              className="shrink-0 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
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
              <span className="text-xs text-neutral-400">接口返回 0 个模型</span>
            )}
          </div>
          {fetchError && <p className="mb-2 text-xs text-red-600">{fetchError}</p>}
          {form.models.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.models.map((m, i) => (
                <span
                  key={m}
                  className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                >
                  {m}
                  {i === 0 && <span className="text-blue-600">默认</span>}
                  <button
                    type="button"
                    aria-label={`移除 ${m}`}
                    onClick={() =>
                      setForm({ ...form, models: form.models.filter((x) => x !== m) })
                    }
                    className="text-neutral-400 hover:text-red-600"
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
              className="shrink-0 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50"
            >
              添加
            </button>
          </div>
        </div>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-neutral-600">
            附加环境变量（可选，每行 KEY=VALUE，# 开头为注释；可覆盖内置注入值）
          </span>
          <textarea
            className={`${field} h-20 font-mono text-xs`}
            placeholder={"HTTPS_PROXY=http://127.0.0.1:7890\nANTHROPIC_SMALL_FAST_MODEL=claude-haiku"}
            value={form.extraEnvText}
            onChange={(e) => setForm({ ...form, extraEnvText: e.target.value })}
          />
        </label>
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ProfilesPage() {
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const removeProfile = useAppStore((s) => s.removeProfile);
  const duplicateProfile = useAppStore((s) => s.duplicateProfile);
  const loadAll = useAppStore((s) => s.loadAll);
  const [modal, setModal] = useState<{ initial: Profile | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [globalBackups, setGlobalBackups] = useState<Record<string, boolean>>({});

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

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold">配置中心</h1>
        <div className="flex gap-2">
          <button
            onClick={onImport}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            导入
          </button>
          <button
            onClick={onExport}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100"
          >
            导出
          </button>
          <button
            onClick={() => setModal({ initial: null })}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            新建配置
          </button>
        </div>
      </div>
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {AGENTS.map((agent) => {
        const det = agents.find((a) => a.id === agent.id);
        const list = profiles.filter((p) => p.agent === agent.id);
        return (
          <section key={agent.id} className="mb-6">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-base font-medium">{agent.label}</h2>
              {det?.binaryPath ? (
                <span className="text-xs text-green-700">
                  已安装{det.version ? ` · ${det.version}` : ""}
                </span>
              ) : (
                <span className="text-xs text-neutral-400">
                  未安装（{agent.binary} 不在 PATH）
                </span>
              )}
            </div>
            {list.length === 0 ? (
              <p className="rounded border border-dashed border-neutral-300 p-4 text-sm text-neutral-400">
                暂无配置
              </p>
            ) : (
              <ul className="divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
                {list.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="truncate text-neutral-500">
                      {p.baseUrl ?? "默认端点"}
                    </span>
                    {p.models.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {p.models.slice(0, 3).map((m, i) => (
                          <span
                            key={m}
                            className={`rounded px-1.5 py-0.5 text-xs ${
                              i === 0
                                ? "bg-blue-50 text-blue-700"
                                : "bg-neutral-100 text-neutral-600"
                            }`}
                          >
                            {m}
                          </span>
                        ))}
                        {p.models.length > 3 && (
                          <span className="text-xs text-neutral-400">
                            +{p.models.length - 3}
                          </span>
                        )}
                      </span>
                    )}
                    <span
                      className={`text-xs ${p.hasKey ? "text-green-700" : "text-neutral-400"}`}
                    >
                      {p.hasKey ? `已存密钥 ${p.keyHint ?? ""}` : "无密钥"}
                    </span>
                    <span className="ml-auto flex shrink-0 gap-2">
                      <button
                        onClick={() => onApplyGlobal(p)}
                        title="写入该 CLI 的全局配置文件（自动备份原文件）"
                        className="text-emerald-700 hover:underline"
                      >
                        设为全局
                      </button>
                      <button
                        onClick={() => setModal({ initial: p })}
                        className="text-blue-600 hover:underline"
                      >
                        编辑
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await duplicateProfile(p.id);
                          } catch (e) {
                            setError(String(e));
                          }
                        }}
                        className="text-neutral-600 hover:underline"
                      >
                        复制
                      </button>
                      <button
                        onClick={() => onDelete(p)}
                        className="text-red-600 hover:underline"
                      >
                        删除
                      </button>
                      {globalBackups[p.agent] && (
                        <button
                          onClick={() => onRestoreBackup(p.agent)}
                          title="恢复最近一次备份的全局配置文件"
                          className="text-neutral-600 hover:underline"
                        >
                          恢复备份
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {modal && (
        <ProfileModal initial={modal.initial} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
