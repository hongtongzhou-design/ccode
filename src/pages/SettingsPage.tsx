import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "../store";

/** 四款深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
const PALETTES = [
  { id: "dark-plus", name: "Dark+", dots: ["#0dbc79", "#2472c8", "#f14c4c", "#e5e510"] },
  { id: "solarized", name: "Solarized", dots: ["#859900", "#268bd2", "#dc322f", "#b58900"] },
  { id: "one-dark", name: "One Dark", dots: ["#98c379", "#61afef", "#e06c75", "#d19a66"] },
  { id: "catppuccin", name: "Catppuccin", dots: ["#a6e3a1", "#89b4fa", "#f38ba8", "#f9e2af"] },
] as const;

const THEMES = [
  { id: "midnight", name: "沉浸黑", rail: "#08090d", canvas: "#11131a", accent: "#16a349" },
  { id: "terracotta", name: "陶土", rail: "#232322", canvas: "#2d2d2b", accent: "#cc7d5e" },
  { id: "ayu", name: "Ayu 琥珀", rail: "#0b0e14", canvas: "#10141c", accent: "#e6b450" },
  { id: "mocha", name: "Catppuccin", rail: "#181824", canvas: "#1e1e2e", accent: "#cba6f7" },
  { id: "neutral", name: "极简灰蓝", rail: "#0d0d0d", canvas: "#111111", accent: "#0169cc" },
  { id: "dracula", name: "Dracula", rail: "#1e2029", canvas: "#282a36", accent: "#ff79c6" },
  { id: "shadcn", name: "灰蓝正红", rail: "#0d1420", canvas: "#111827", accent: "#ff5c5c" },
] as const;

const field =
  "rounded border border-field bg-canvas px-2 py-1 text-sm text-l2 outline-none focus:border-l4";

/** 「外部终端」下拉的选项按平台给（navigator.platform 在 WKWebView/Chromium 均可用） */
const EXTERNAL_TERMINALS: { id: string; label: string }[] = (() => {
  const p = navigator.platform || "";
  if (p.startsWith("Mac"))
    return [
      { id: "auto", label: "自动（Ghostty → iTerm → 终端）" },
      { id: "ghostty", label: "Ghostty" },
      { id: "iterm", label: "iTerm2" },
      { id: "terminal", label: "终端 Terminal.app" },
    ];
  if (p.startsWith("Win")) return [{ id: "cmd", label: "cmd 新窗口" }];
  return [
    { id: "auto", label: "自动（按优先级探测）" },
    { id: "gnome-terminal", label: "GNOME Terminal" },
    { id: "konsole", label: "Konsole" },
    { id: "xfce4-terminal", label: "Xfce Terminal" },
    { id: "xterm", label: "XTerm" },
  ];
})();

/** 诊断日志条目（与后端 logbuf::LogEntryDto 对应） */
type LogEntry = { ts: string; level: string; source: string; message: string };

/** 分区折叠状态在 localStorage 的键（只记被折叠的分区，默认全部展开） */
const SECTIONS_KEY = "ccode.settings.sections";

/** 可折叠分区：标题行整行可点（高 32px），▸/▾ 指示展开状态 */
function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 first:mt-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-1.5 rounded px-1 text-left text-sm font-medium text-l1 hover:bg-white/5"
      >
        <span className="w-3 text-xs text-l4">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline py-3">
      <span className="w-32 shrink-0 text-sm text-l2">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
      {hint && <span className="text-xs text-l4">{hint}</span>}
    </div>
  );
}

export default function SettingsPage({ visible }: { visible: boolean }) {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const profiles = useAppStore((s) => s.profiles);
  const loadAll = useAppStore((s) => s.loadAll);
  const appUpdate = useAppStore((s) => s.appUpdate);
  const checkAppUpdate = useAppStore((s) => s.checkAppUpdate);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 数值输入的本地草稿（失焦/回车才提交，避免每击键一次 IPC）
  const [fontSize, setFontSize] = useState("");
  const [fontFamily, setFontFamily] = useState("JetBrains Mono");
  const [customFont, setCustomFont] = useState("");
  const [scrollback, setScrollback] = useState("");
  const [rate, setRate] = useState("");
  const [pricing, setPricing] = useState("");
  const [pricingDirty, setPricingDirty] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);
  // 诊断日志（进程内环形缓冲，分区展开时拉最近 100 条）
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // 分区折叠状态：默认全部展开，切换时写 localStorage
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  function toggleSection(id: string) {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  useEffect(() => {
    if (visible) {
      loadSettings().catch((e) => setError(String(e)));
      // AI 专用配置下拉需要 profile 列表
      if (profiles.length === 0) loadAll().catch(() => {});
      invoke<string>("read_pricing_file")
        .then((t) => {
          setPricing(t);
          setPricingDirty(false);
        })
        .catch((e) => setError(String(e)));
    }
  }, [visible, loadSettings]);

  // settings 到达后同步草稿
  useEffect(() => {
    if (settings) {
      setFontSize(String(settings.terminalFontSize));
      setScrollback(String(settings.scrollback));
      setRate(String(settings.rateUsdCny));
      const fam = settings.terminalFontFamily ?? "JetBrains Mono";
      if (["JetBrains Mono", "SF Mono", "Menlo", "Consolas"].includes(fam)) {
        setFontFamily(fam);
      } else {
        setFontFamily("__custom__");
        setCustomFont(fam);
      }
    }
  }, [settings]);

  async function patch(p: Parameters<typeof updateSettings>[0]) {
    setError(null);
    try {
      await updateSettings(p);
    } catch (e) {
      setError(String(e));
    }
  }

  function commitNumber(
    raw: string,
    min: number,
    max: number,
    apply: (n: number) => void,
  ) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    apply(Math.min(max, Math.max(min, Math.round(n * 100) / 100)));
  }

  async function savePricing() {
    setSavingPricing(true);
    setError(null);
    try {
      await invoke("write_pricing_file", { text: pricing });
      setPricingDirty(false);
      setNotice("已保存，下一次统计查询生效");
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingPricing(false);
    }
  }

  async function loadLogs() {
    try {
      setLogs(await invoke<LogEntry[]>("get_app_log", { limit: 100 }));
    } catch (e) {
      setError(String(e));
    }
  }

  // 「诊断」分区展开（且页面可见）时拉取日志
  useEffect(() => {
    if (visible && !collapsed.diag) loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, collapsed.diag]);

  async function clearLogs() {
    setError(null);
    try {
      await invoke("clear_app_log");
      setLogs([]);
    } catch (e) {
      setError(String(e));
    }
  }

  // 下载并安装应用更新：成功后 relaunch 进新版本；失败恢复按钮可重试
  async function installUpdate() {
    if (!appUpdate || installing) return;
    setInstalling(true);
    setError(null);
    try {
      await appUpdate.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setError(String(e));
      setInstalling(false);
    }
  }

  async function copyLogs() {
    const text = logs
      .map((l) => `${l.ts} [${l.level}] ${l.source}: ${l.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制到剪贴板");
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-l1">设置</h1>
      </div>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      <Section title="外观" open={!collapsed.appearance} onToggle={() => toggleSection("appearance")}>
      {/* 主题 */}
      <div className="border-b border-hairline py-3">
        <div className="mb-2 text-sm text-l2">主题</div>
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => patch({ theme: t.id })}
              title={`切换到${t.name}`}
              className={`w-20 rounded-md border p-1.5 text-center text-xs ${
                settings?.theme === t.id
                  ? "border-cta-bd text-l1"
                  : "border-field text-l3 hover:text-l1"
              }`}
            >
              <span className="mb-1 flex h-8 overflow-hidden rounded">
                <span className="h-full w-1/2" style={{ background: t.rail }} />
                <span className="h-full w-1/2" style={{ background: t.canvas }} />
                <span
                  className="h-full w-1.5"
                  style={{ background: t.accent }}
                  title="强调色"
                />
              </span>
              {t.name}
              {settings?.theme === t.id && <span className="ml-0.5 text-ok-text">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <Row label="终端字号" hint="立即生效（11–18）">
        <input
          type="number"
          min={11}
          max={18}
          className={`${field} w-20`}
          value={fontSize}
          onChange={(e) => setFontSize(e.target.value)}
          onBlur={() =>
            commitNumber(fontSize, 11, 18, (n) => patch({ terminalFontSize: n }))
          }
          onKeyDown={(e) =>
            e.key === "Enter" &&
            commitNumber(fontSize, 11, 18, (n) => patch({ terminalFontSize: n }))
          }
        />
      </Row>

      <Row label="终端字体" hint="立即生效；选「自定义」可输入系统已装字体名">
        <div className="flex items-center gap-2">
          <select
            className={field}
            value={fontFamily}
            onChange={(e) => {
              setFontFamily(e.target.value);
              if (e.target.value !== "__custom__") patch({ terminalFontFamily: e.target.value });
            }}
          >
            <option value="JetBrains Mono">JetBrains Mono（内置）</option>
            <option value="SF Mono">SF Mono（macOS）</option>
            <option value="Menlo">Menlo（macOS）</option>
            <option value="Consolas">Consolas</option>
            <option value="__custom__">自定义…</option>
          </select>
          {fontFamily === "__custom__" && (
            <input
              className={`${field} w-40`}
              placeholder="字体名，如 Fira Code"
              value={customFont}
              onChange={(e) => setCustomFont(e.target.value)}
              onBlur={() => customFont.trim() && patch({ terminalFontFamily: customFont.trim() })}
              onKeyDown={(e) =>
                e.key === "Enter" && customFont.trim() && patch({ terminalFontFamily: customFont.trim() })
              }
            />
          )}
        </div>
      </Row>

      <Row label="终端调色板" hint="终端内 16 种 ANSI 颜色风格，立即生效">
        <div className="flex gap-2">
          {PALETTES.map((pl) => (
            <button
              key={pl.id}
              onClick={() => patch({ terminalPalette: pl.id })}
              title={pl.name}
              className={`rounded-md border p-1.5 text-xs ${
                (settings?.terminalPalette ?? "dark-plus") === pl.id
                  ? "border-cta-bd text-l1"
                  : "border-field text-l3 hover:text-l1"
              }`}
            >
              <span className="flex h-3 gap-0.5">
                {pl.dots.map((d) => (
                  <span key={d} className="h-3 w-3 rounded-sm" style={{ background: d }} />
                ))}
              </span>
            </button>
          ))}
        </div>
      </Row>

      <Row label="滚动缓冲行数" hint="新开标签生效（1000–20000）">
        <input
          type="number"
          min={1000}
          max={20000}
          step={1000}
          className={`${field} w-24`}
          value={scrollback}
          onChange={(e) => setScrollback(e.target.value)}
          onBlur={() => commitNumber(scrollback, 1000, 20000, (n) => patch({ scrollback: n }))}
          onKeyDown={(e) =>
            e.key === "Enter" && commitNumber(scrollback, 1000, 20000, (n) => patch({ scrollback: n }))
          }
        />
      </Row>
      </Section>

      <Section title="统计" open={!collapsed.stats} onToggle={() => toggleSection("stats")}>
      <Row label="汇率（USD→CNY）" hint="统计页下次查询生效">
        <input
          type="number"
          step={0.01}
          min={0}
          className={`${field} w-24`}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          onBlur={() => commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }))}
          onKeyDown={(e) =>
            e.key === "Enter" && commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }))
          }
        />
      </Row>

      {/* 自定义定价 */}
      <div className="py-3">
        <div className="mb-1 flex items-center gap-3">
          <span className="w-32 shrink-0 text-sm text-l2">自定义定价</span>
          <span className="text-xs text-l4">pricing.json，保存时校验 JSON</span>
          <button
            onClick={savePricing}
            disabled={!pricingDirty || savingPricing}
            className="ml-auto rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            {savingPricing ? "保存中…" : "保存"}
          </button>
        </div>
        <textarea
          className={`${field} h-40 w-full font-mono text-xs`}
          placeholder='{"model-id": {"input": 2.5, "output": 10}}'
          value={pricing}
          onChange={(e) => {
            setPricing(e.target.value);
            setPricingDirty(true);
          }}
        />
      </div>
      </Section>

      <Section title="集成" open={!collapsed.integration} onToggle={() => toggleSection("integration")}>
      <Row label="brew 镜像" hint="安装/更新走清华 TUNA 镜像">
        <input
          type="checkbox"
          checked={settings?.brewMirror ?? false}
          onChange={(e) => patch({ brewMirror: e.target.checked })}
        />
      </Row>

      <Row label="AI 专用配置" hint="◈ 生成（提交信息/摘要/PR）固定走此配置，建议选快模型；默认自动=最近使用">
        <select
          className={field}
          value={settings?.aiProfileId ?? ""}
          onChange={(e) => patch({ aiProfileId: e.target.value })}
        >
          <option value="">自动（最近使用）</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.agent}{p.models[0] ? ` · ${p.models[0]}` : ""}）
            </option>
          ))}
        </select>
      </Row>

      <Row label="外部终端" hint="会话页「⇗ 外部恢复」使用的终端应用，立即生效">
        <select
          className={field}
          value={settings?.externalTerminal ?? "auto"}
          onChange={(e) => patch({ externalTerminal: e.target.value })}
        >
          {EXTERNAL_TERMINALS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Row>
      </Section>

      <Section title="更新" open={!collapsed.update} onToggle={() => toggleSection("update")}>
      <div className="py-3">
        {appUpdate ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm text-l2">
                发现新版本 <span className="text-l1">v{appUpdate.version}</span>
                <span className="ml-2 text-xs text-l4">当前 v{appUpdate.currentVersion}</span>
              </span>
              <button
                onClick={installUpdate}
                disabled={installing}
                className="ml-auto h-8 rounded border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
              >
                {installing ? "下载安装中…" : "下载并安装"}
              </button>
            </div>
            {appUpdate.body && (
              <div className="max-h-48 overflow-auto whitespace-pre-line rounded bg-inset p-2 text-xs leading-5 text-l3">
                {appUpdate.body}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-l4">未发现新版本（启动时已自动检查）</span>
            <button
              onClick={() => checkAppUpdate()}
              className="ml-auto rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5"
            >
              重新检查
            </button>
          </div>
        )}
      </div>
      </Section>

      <Section title="诊断" open={!collapsed.diag} onToggle={() => toggleSection("diag")}>
      <div className="py-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs text-l4">
            最近 100 条应用日志（进程内缓冲，重启即清空）
          </span>
          <button
            onClick={loadLogs}
            className="ml-auto rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5"
          >
            刷新
          </button>
          <button
            onClick={copyLogs}
            disabled={logs.length === 0}
            className="rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            复制全部
          </button>
          <button
            onClick={clearLogs}
            disabled={logs.length === 0}
            className="rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            清空
          </button>
        </div>
        {logs.length === 0 ? (
          <p className="text-xs text-l4">暂无日志</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded bg-inset p-2 font-mono text-xs leading-5">
            {logs.map((l, i) => (
              <div key={i} className="break-all">
                <span className="text-l4">{l.ts.replace("T", " ").replace("Z", "")} </span>
                <span
                  className={
                    l.level === "error"
                      ? "text-err-text"
                      : l.level === "warn"
                        ? "text-warn-text"
                        : "text-l3"
                  }
                >
                  [{l.level}]
                </span>{" "}
                <span className="text-l3">{l.source}:</span>{" "}
                <span className="text-l2">{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      </Section>
    </div>
  );
}
