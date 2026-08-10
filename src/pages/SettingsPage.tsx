import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { useAppStore } from "../store";
import type { AppSettings } from "../store";
import {
  fieldClass,
  ghostActionClass,
  hoverRevealClass,
  PageFrame,
  PageHeader,
  rowActionClass,
  Toggle,
} from "../components/PageFrame";
import { captureDecision, comboLabel } from "../hotkeys";
import { collectFrontendDiagnostics } from "../diagnostics";

/** 七套深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
import { XTERM_PALETTES, PALETTE_PREVIEW_KEYS } from "../terminal-palettes";
import { THEMES } from "../themes";

const PALETTES = [
  { id: "dark-plus", name: "Dark+" },
  { id: "solarized", name: "Solarized" },
  { id: "one-dark", name: "One Dark" },
  { id: "catppuccin", name: "Catppuccin" },
] as const;

/** 色卡预览：取共享调色板表的前 8 个 ANSI 标准色（与终端实际生效色一致） */
function paletteDots(id: string): string[] {
  const p = XTERM_PALETTES[id] ?? XTERM_PALETTES["dark-plus"];
  return PALETTE_PREVIEW_KEYS.map((k) => p[k]);
}

// 主题清单单一出处在 ../themes（命令面板共用）

type ThemeSwatch = { rail: string; canvas: string; accent: string };

/** 预览色运行时从 CSS 变量读取：临时切 data-theme 同步读回再还原，
    避免与 src/App.css 双份维护色值漂移（App.css 无 transition，同步还原不会闪烁） */
function readThemeSwatch(id: string): ThemeSwatch {
  const el = document.documentElement;
  const prev = el.dataset.theme;
  el.dataset.theme = id;
  const cs = getComputedStyle(el);
  const swatch = {
    rail: cs.getPropertyValue("--color-rail").trim(),
    canvas: cs.getPropertyValue("--color-canvas").trim(),
    accent: cs.getPropertyValue("--color-cta").trim(),
  };
  if (prev === undefined) el.removeAttribute("data-theme");
  else el.dataset.theme = prev;
  return swatch;
}

// fieldClass 自带 w-full：本页 Row 右列是收缩到内容的 auto 列，定宽控件（w-20/w-24/w-40）
// 追加的宽度类在 Tailwind 排序中会被 w-full 覆盖，故用去掉 w-full 的本页变体保持原宽度
const fieldFixed = fieldClass.replace("w-full ", "");

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

/** 内置 AI 功能按功能独立配置的行（key 与后端 ai.rs FN_* 常量对应） */
const AI_FN_ROWS: { key: string; label: string }[] = [
  { key: "commit", label: "提交信息" },
  { key: "summarize", label: "会话摘要" },
  { key: "pr", label: "PR 描述" },
  { key: "distill", label: "沉淀为技能" },
  { key: "digest", label: "提炼接力" },
  { key: "conflict", label: "冲突建议" },
  { key: "translate", label: "翻译" },
];

/** 诊断日志条目（与后端 logbuf::LogEntryDto 对应） */
type LogEntry = { ts: string; level: string; source: string; message: string };

/** 可一键安装的字体预设：下拉字体名 → 后端字体 id（内置/系统/自定义不在安装范围） */
const INSTALLABLE_FONTS: Record<string, string> = {
  "Maple Mono NF CN": "maple",
  "Sarasa Mono SC": "sarasa",
  Iosevka: "iosevka",
};

/** 与后端 fonts::FontStatusDto / FontInstallDto 对应 */
type FontStatus = { id: string; family: string; installed: boolean };
type FontInstallResult = { ok: boolean; output: string };

/** 分区折叠状态在 localStorage 的键。首次仅展开高频外观，长说明按需展开。 */
const SECTIONS_KEY = "ccode.settings.sections";
const DEFAULT_COLLAPSED: Record<string, boolean> = {
  stats: true,
  integration: true,
  update: true,
  diag: true,
};

/** 可折叠分区：标题行整行可点（高 32px），▸/▾ 指示展开状态；badge 为标题右侧状态标记 */
function Section({
  title,
  open,
  onToggle,
  badge,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7 first:mt-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={`flex h-8 w-full items-center gap-1.5 text-left text-sm font-medium text-l1 ${open ? "border-b border-hairline" : ""}`}
      >
        <span className="w-3 text-xs text-l4">{open ? "▾" : "▸"}</span>
        {title}
        {badge}
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}

function Row({
  label,
  hint,
  extra,
  children,
}: {
  label: string;
  hint?: string;
  /** 行下方全宽区域（如字体安装的流式输出），不传不渲染 */
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(180px,1fr)_auto] items-center gap-x-5 border-b border-hairline py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-l2">{label}</div>
        {hint && <p className="mt-0.5 max-w-lg text-[11px] leading-4 text-l4">{hint}</p>}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
      {extra && <div className="col-span-2 mt-2">{extra}</div>}
    </div>
  );
}

/** 快捷键录制钮：点击进入监听态，按下新组合即保存；Esc 取消，与另一绑定冲突时拒绝并提示。
 *  macOS WKWebView 点击 button 默认不给键盘焦点，onKeyDown 挂按钮上永远收不到按键；
 *  监听态改挂 window 级 capture 监听（capture 先于 App.tsx 的 bubble 全局快捷键触发，
 *  stopImmediatePropagation 把同节点其余监听一并压过），退出监听态即卸载 */
function HotkeyCapture({
  value,
  defaultValue,
  conflictWith,
  onSave,
}: {
  /** 当前绑定（"" = 已禁用） */
  value: string;
  defaultValue: string;
  /** 另一个可编辑绑定的当前值，用于防冲突 */
  conflictWith: string;
  onSave: (combo: string) => void;
}) {
  const [listening, setListening] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      // 录制期间吞掉全部按键：防默认行为（如 ⌘K 的浏览器动作）与全局快捷键触发
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = captureDecision(e, conflictWith);
      if (d.action === "cancel") {
        setListening(false);
      } else if (d.action === "conflict") {
        // 留在监听态，可继续按其他组合
        setConflict(true);
      } else if (d.action === "save") {
        onSave(d.combo);
        setConflict(false);
        setListening(false);
      }
      // ignore：纯修饰键/无修饰键，继续等待
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, conflictWith, onSave]);

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setListening(true);
          setConflict(false);
        }}
        className={`inline-flex h-7 min-w-16 items-center justify-center rounded-md border px-2 font-mono text-xs ${
          listening
            ? "border-cta-bd bg-inset text-cta"
            : conflict
              ? "border-err-text/50 text-err-text"
              : "border-field bg-inset text-l2"
        }`}
      >
        {listening ? "按下新快捷键…" : comboLabel(value)}
      </button>
      {conflict && <span className="text-xs text-err-text">与另一个快捷键冲突</span>}
      {value !== defaultValue && (
        <button
          type="button"
          onClick={() => {
            setListening(false); // 监听中直接改绑定：退出监听态，防后续按键再覆盖
            onSave(defaultValue);
          }}
          className={ghostActionClass}
        >
          恢复默认
        </button>
      )}
      {value !== "" && (
        <button
          type="button"
          onClick={() => {
            setListening(false);
            onSave("");
          }}
          className={ghostActionClass}
        >
          禁用
        </button>
      )}
    </span>
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
  // 自定义定价的表格草稿（保存时序列化为 pricing.json 的 {"前缀":[输入,输出]} 格式，后端校验不变）
  const [pricingRows, setPricingRows] = useState<
    { prefix: string; input: string; output: string }[]
  >([]);
  // 文件里已有的 _rate 原样保留（汇率主入口是上方「汇率」设置项，这里只为了不丢数据）
  const [pricingRateExtra, setPricingRateExtra] = useState<number | null>(null);
  const [pricingDirty, setPricingDirty] = useState(false);
  // 未提交草稿标记（ref 镜像供 effect 内读取）：settings 变化（如切主题）时不覆盖正在编辑的输入框
  const draftDirty = useRef(new Set<string>());
  const pricingDirtyRef = useRef(false);
  function markPricingDirty(d: boolean) {
    pricingDirtyRef.current = d;
    setPricingDirty(d);
  }
  const [savingPricing, setSavingPricing] = useState(false);
  // 诊断日志（进程内环形缓冲，分区展开时拉最近 100 条）
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diagnosticsExporting, setDiagnosticsExporting] = useState(false);
  // 可安装字体预设的安装状态（id → installed）：进页面查一次缓存，安装成功后刷新
  const [fontStatus, setFontStatus] = useState<Record<string, boolean>>({});
  // 字体安装进行态 / 实时输出 / 最近结果；target 记录本次安装的字体 id（切换选择后隐藏旧输出）
  const [fontInstalling, setFontInstalling] = useState(false);
  const [fontInstallOutput, setFontInstallOutput] = useState("");
  const [fontInstallResult, setFontInstallResult] =
    useState<FontInstallResult | null>(null);
  const [fontInstallTarget, setFontInstallTarget] = useState<string | null>(
    null,
  );
  // 分区折叠状态：首次仅展开高频外观，切换后持久化。
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(SECTIONS_KEY);
      return raw ? JSON.parse(raw) : DEFAULT_COLLAPSED;
    } catch {
      return DEFAULT_COLLAPSED;
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
      refreshFontStatus();
      // 有未保存草稿时保留，不用文件内容覆盖
      if (!pricingDirtyRef.current) {
        invoke<string>("read_pricing_file")
          .then((t) => {
            if (!t.trim()) {
              setPricingRows([]);
              setPricingRateExtra(null);
            } else {
              // 解析失败（手改坏的存量文件）：提示并给空表，保存即覆盖
              try {
                const v = JSON.parse(t) as Record<string, unknown>;
                setPricingRateExtra(
                  typeof v._rate === "number" ? v._rate : null,
                );
                setPricingRows(
                  Object.entries(v)
                    .filter(([k, val]) => k !== "_rate" && Array.isArray(val))
                    .map(([prefix, val]) => ({
                      prefix,
                      input: String((val as unknown[])[0] ?? ""),
                      output: String((val as unknown[])[1] ?? ""),
                    })),
                );
              } catch (e) {
                setPricingRows([]);
                setPricingRateExtra(null);
                setError(`pricing.json 解析失败（${e}），编辑后保存将覆盖原文件`);
              }
            }
            markPricingDirty(false);
          })
          .catch((e) => setError(String(e)));
      }
    }
  }, [visible, loadSettings]);

  // settings 到达后同步草稿（正在编辑、未提交的输入框跳过）
  useEffect(() => {
    if (settings) {
      const dirty = draftDirty.current;
      if (!dirty.has("fontSize"))
        setFontSize(String(settings.terminalFontSize));
      if (!dirty.has("scrollback")) setScrollback(String(settings.scrollback));
      if (!dirty.has("rate")) setRate(String(settings.rateUsdCny));
      if (!dirty.has("customFont")) {
        const fam = settings.terminalFontFamily ?? "JetBrains Mono";
        if (["JetBrains Mono", "Maple Mono NF CN", "Sarasa Mono SC", "Iosevka", "SF Mono", "Menlo", "Consolas"].includes(fam)) {
          setFontFamily(fam);
        } else {
          setFontFamily("__custom__");
          setCustomFont(fam);
        }
      }
    }
  }, [settings]);

  // 主题色卡只算一次：七套主题的 CSS 变量在会话内不变
  const themeSwatches = useMemo(
    () => THEMES.map((t) => ({ ...t, ...readThemeSwatch(t.id) })),
    [],
  );

  async function patch(p: Parameters<typeof updateSettings>[0]) {
    setError(null);
    try {
      await updateSettings(p);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 按功能 AI 配置：改一键后整图提交；空值 = 删除该键（跟随默认） */
  function patchAiFnProfile(fnKey: string, profileId: string) {
    const next = { ...(settings?.aiProfiles ?? {}) };
    if (profileId) next[fnKey] = profileId;
    else delete next[fnKey];
    void patch({ aiProfiles: next });
  }

  /** 精确注意力标记开关：走专用命令（写/移除 ~/.claude/settings.json hooks 段 + 记设置），
      不走普通 patch——失败时设置不落库，避免开关显示与实际安装不一致 */
  const [hooksBusy, setHooksBusy] = useState(false);
  async function toggleClaudeHooks(enabled: boolean) {
    if (hooksBusy) return;
    setError(null);
    setHooksBusy(true);
    try {
      const s = await invoke<AppSettings>("set_claude_hooks_attention", {
        enabled,
      });
      useAppStore.setState({ settings: s });
      setNotice(
        enabled
          ? "已开启：Claude Code hooks 已写入 ~/.claude/settings.json"
          : "已关闭：Claude Code hooks 已移除",
      );
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setHooksBusy(false);
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
      // 表格序列化回 pricing.json 既有格式：{"前缀": [输入价, 输出价]}；空前缀行丢弃
      const obj: Record<string, unknown> = {};
      if (pricingRateExtra != null) obj._rate = pricingRateExtra;
      for (const row of pricingRows) {
        const prefix = row.prefix.trim();
        if (!prefix) continue;
        obj[prefix] = [Number(row.input) || 0, Number(row.output) || 0];
      }
      const text = Object.keys(obj).length
        ? JSON.stringify(obj, null, 2)
        : "";
      await invoke("write_pricing_file", { text });
      markPricingDirty(false);
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

  async function refreshFontStatus() {
    try {
      const list = await invoke<FontStatus[]>("font_status");
      setFontStatus(Object.fromEntries(list.map((f) => [f.id, f.installed])));
    } catch {
      /* 字体检测失败不阻断设置页 */
    }
  }

  /** 一键安装字体：先挂事件监听再 invoke；结果以 done 事件为准，invoke 返回值兜底
      （同 ProfilesPage runAgentCmd 模式；brew cask 无需交互，不挂输入行） */
  async function installFont(fontId: string) {
    setFontInstalling(true);
    setFontInstallTarget(fontId);
    setFontInstallOutput("");
    setFontInstallResult(null);
    const unOut = await listen<string>("font-install-output", (e) => {
      setFontInstallOutput((prev) => prev + e.payload);
    });
    let doneArrived = false;
    const unDone = await listen<FontInstallResult>("font-install-done", (e) => {
      doneArrived = true;
      setFontInstallResult(e.payload);
    });
    try {
      const res = await invoke<FontInstallResult>("install_font", { fontId });
      if (!doneArrived) setFontInstallResult(res);
      // emit_done 推送与 invoke 返回的是同一份结果，ok 以 res 为准即可
      if (res.ok) await refreshFontStatus();
    } catch (e) {
      if (!doneArrived)
        setFontInstallResult({ ok: false, output: String(e) });
    } finally {
      unOut();
      unDone();
      setFontInstalling(false);
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

  async function exportDiagnosticsBundle() {
    if (diagnosticsExporting) return;
    setDiagnosticsExporting(true);
    setError(null);
    try {
      const path = await invoke<string>("export_diagnostics_bundle", {
        frontend: collectFrontendDiagnostics(),
      });
      setNotice(`诊断包已导出：${path}`);
      setTimeout(() => setNotice(null), 5000);
      await loadLogs();
    } catch (e) {
      setError(String(e));
    } finally {
      setDiagnosticsExporting(false);
    }
  }

  return (
    <PageFrame width="standard">
      <PageHeader title="设置" meta="外观、终端与应用集成" />
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      <Section
        title="外观"
        open={!collapsed.appearance}
        onToggle={() => toggleSection("appearance")}
      >
        {/* 主题：七套深色一行，对应浅色正下方一列对齐（grid-cols-7） */}
        <div className="border-b border-hairline py-3">
          <div className="mb-2 text-sm text-l2">主题</div>
          <div className="grid grid-cols-7 gap-2 overflow-x-auto">
            {themeSwatches.map((t) => (
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
                  <span
                    className="h-full w-1/2"
                    style={{ background: t.rail }}
                  />
                  <span
                    className="h-full w-1/2"
                    style={{ background: t.canvas }}
                  />
                  <span
                    className="h-full w-1.5"
                    style={{ background: t.accent }}
                    title="强调色"
                  />
                </span>
                {t.name}
                {settings?.theme === t.id && (
                  <span className="ml-0.5 text-ok-text">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <Row label="终端字号" hint="立即生效（11–18）">
          <input
            type="number"
            min={11}
            max={18}
            className={`${fieldFixed} w-20`}
            value={fontSize}
            onChange={(e) => {
              draftDirty.current.add("fontSize");
              setFontSize(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("fontSize");
              commitNumber(fontSize, 11, 18, (n) =>
                patch({ terminalFontSize: n }),
              );
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("fontSize");
              commitNumber(fontSize, 11, 18, (n) =>
                patch({ terminalFontSize: n }),
              );
            }}
          />
        </Row>

        <Row
          label="终端字体"
          hint="立即生效；Maple/Sarasa/Iosevka 未安装时可在行内一键安装（走 Homebrew）；选「自定义」可输入系统已装字体名"
          extra={
            fontInstallTarget &&
            fontInstallTarget === INSTALLABLE_FONTS[fontFamily] &&
            (fontInstalling || fontInstallResult) ? (
              <div className="mt-2">
                {fontInstalling && (
                  <pre
                    // callback ref：每次渲染都把滚动条钉在底部，跟随输出自动滚动
                    ref={(el) => {
                      if (el) el.scrollTop = el.scrollHeight;
                    }}
                    className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-inset p-2 font-mono text-xs text-l3"
                  >
                    {fontInstallOutput || "安装中，等待输出…"}
                  </pre>
                )}
                {!fontInstalling && fontInstallResult && (
                  <div className="rounded bg-strip p-2 text-xs text-l2">
                    <span
                      className={
                        fontInstallResult.ok ? "text-ok-text" : "text-err-text"
                      }
                    >
                      {fontInstallResult.ok ? "✓ 安装完成" : "✗ 安装失败"}
                    </span>
                    {/* 后端只回传尾部 ~30 行，直接展示不折叠 */}
                    {fontInstallResult.output && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-l3">
                        {fontInstallResult.output}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ) : undefined
          }
        >
          <div className="flex items-center gap-2">
            <select
              className={fieldFixed}
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value);
                if (e.target.value !== "__custom__") {
                  draftDirty.current.delete("customFont");
                  patch({ terminalFontFamily: e.target.value });
                } else {
                  // 选中「自定义」但未提交字体名，同属未提交草稿
                  draftDirty.current.add("customFont");
                }
              }}
            >
              <option value="JetBrains Mono">JetBrains Mono（内置）</option>
              <option value="Maple Mono NF CN">Maple Mono NF CN（中文+Nerd Font）</option>
              <option value="Sarasa Mono SC">Sarasa Mono SC（中文）</option>
              <option value="Iosevka">Iosevka</option>
              <option value="SF Mono">SF Mono（macOS）</option>
              <option value="Menlo">Menlo（macOS）</option>
              <option value="Consolas">Consolas</option>
              <option value="__custom__">自定义…</option>
            </select>
            {fontFamily === "__custom__" && (
              <input
                className={`${fieldFixed} w-40`}
                placeholder="字体名，如 Fira Code"
                value={customFont}
                onChange={(e) => {
                  draftDirty.current.add("customFont");
                  setCustomFont(e.target.value);
                }}
                onBlur={() => {
                  if (customFont.trim()) {
                    draftDirty.current.delete("customFont");
                    patch({ terminalFontFamily: customFont.trim() });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customFont.trim()) {
                    draftDirty.current.delete("customFont");
                    patch({ terminalFontFamily: customFont.trim() });
                  }
                }}
              />
            )}
            {/* 选中可安装预设且检测未安装时显示一键安装（已装/内置/系统/自定义不显示） */}
            {INSTALLABLE_FONTS[fontFamily] &&
              fontStatus[INSTALLABLE_FONTS[fontFamily]] === false && (
                <button
                  onClick={() => installFont(INSTALLABLE_FONTS[fontFamily])}
                  disabled={fontInstalling}
                  title="通过 Homebrew 安装该字体"
                  className="h-7 shrink-0 rounded border border-cta-bd bg-cta px-2.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {fontInstalling &&
                  fontInstallTarget === INSTALLABLE_FONTS[fontFamily]
                    ? "安装中…"
                    : "安装"}
                </button>
              )}
          </div>
        </Row>

        <Row label="终端调色板" hint="立即生效">
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
                {/* 8 色无缝色条：分段 flex-1 自适应固定宽度，色数变化也不撑破布局 */}
                <span className="flex h-3 w-16 overflow-hidden rounded-sm">
                  {paletteDots(pl.id).map((d) => (
                    <span
                      key={d}
                      className="flex-1"
                      style={{ background: d }}
                    />
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
            className={`${fieldFixed} w-24`}
            value={scrollback}
            onChange={(e) => {
              draftDirty.current.add("scrollback");
              setScrollback(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("scrollback");
              commitNumber(scrollback, 1000, 20000, (n) =>
                patch({ scrollback: n }),
              );
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("scrollback");
              commitNumber(scrollback, 1000, 20000, (n) =>
                patch({ scrollback: n }),
              );
            }}
          />
        </Row>

        <Row
          label="长任务 OS 通知"
          hint="agent 从工作中转为待确认/已完成且窗口未聚焦时发系统通知（同一标签 30 秒内最多一条）；首次发送需允许系统通知权限"
        >
          <Toggle
            label="长任务 OS 通知"
            checked={settings?.notificationsEnabled ?? true}
            onChange={(checked) => patch({ notificationsEnabled: checked })}
          />
        </Row>
      </Section>

      {/* 快捷键：点击绑定钮进入录制态，按下新组合即保存；空串 = 禁用 */}
      <Section
        title="快捷键"
        open={!collapsed.hotkeys}
        onToggle={() => toggleSection("hotkeys")}
      >
        <Row label="命令面板" hint="呼出页面跳转 / 主题切换 / 侧栏显隐">
          <HotkeyCapture
            value={settings?.hotkeyPalette ?? "mod+k"}
            defaultValue="mod+k"
            conflictWith={settings?.hotkeyHideChrome ?? "mod+\\"}
            onSave={(combo) => void patch({ hotkeyPalette: combo })}
          />
        </Row>
        <Row label="隐藏 / 显示侧栏" hint="执行态：界面只剩工作内容">
          <HotkeyCapture
            value={settings?.hotkeyHideChrome ?? "mod+\\"}
            defaultValue="mod+\\"
            conflictWith={settings?.hotkeyPalette ?? "mod+k"}
            onSave={(combo) => void patch({ hotkeyHideChrome: combo })}
          />
        </Row>
        <Row
          label="⌘1–⌘8 页面切换"
          hint="按侧栏顺序直接切页（一组八个绑定，整组开关）"
        >
          <Toggle
            checked={settings?.hotkeyPageSwitch !== false}
            onChange={(v) => void patch({ hotkeyPageSwitch: v })}
            label="⌘1–⌘8 页面切换"
          />
        </Row>
      </Section>

      <Section
        title="统计"
        open={!collapsed.stats}
        onToggle={() => toggleSection("stats")}
      >
        <Row label="汇率（USD→CNY）" hint="统计页下次查询生效">
          <input
            type="number"
            step={0.01}
            min={0}
            className={`${fieldFixed} w-24`}
            value={rate}
            onChange={(e) => {
              draftDirty.current.add("rate");
              setRate(e.target.value);
            }}
            onBlur={() => {
              draftDirty.current.delete("rate");
              commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }));
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              draftDirty.current.delete("rate");
              commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }));
            }}
          />
        </Row>

        {/* 自定义定价：表格编辑（每行 = 模型前缀 + 输入/输出价），保存时序列化为 pricing.json */}
        <div className="py-3">
          <div className="mb-1 flex items-center gap-3">
            <span className="w-32 shrink-0 text-sm text-l2">自定义定价</span>
            <span className="text-xs text-l4">
              美元 / 每百万 token，按模型名前缀匹配（覆盖内置价目）
            </span>
            <button
              onClick={savePricing}
              disabled={!pricingDirty || savingPricing}
              className={`ml-auto ${rowActionClass}`}
            >
              {savingPricing ? "保存中…" : "保存"}
            </button>
          </div>
          {pricingRows.length > 0 && (
            <div className="mb-1 grid grid-cols-[minmax(140px,1fr)_7rem_7rem_28px] items-center gap-2 px-1 text-xs text-l4">
              <span>模型前缀</span>
              <span>输入价</span>
              <span>输出价</span>
              <span />
            </div>
          )}
          <div className="space-y-1">
            {pricingRows.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-[minmax(140px,1fr)_7rem_7rem_28px] items-center gap-2"
              >
                <input
                  className={fieldClass}
                  placeholder="如 kimi-k3"
                  value={row.prefix}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, prefix: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <input
                  className={fieldClass}
                  placeholder="2.5"
                  inputMode="decimal"
                  value={row.input}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, input: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <input
                  className={fieldClass}
                  placeholder="10"
                  inputMode="decimal"
                  value={row.output}
                  onChange={(e) => {
                    const next = [...pricingRows];
                    next[i] = { ...row, output: e.target.value };
                    setPricingRows(next);
                    markPricingDirty(true);
                  }}
                />
                <button
                  type="button"
                  aria-label={`删除 ${row.prefix || "该行"}`}
                  className="flex h-7 w-7 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-err-text"
                  onClick={() => {
                    setPricingRows(pricingRows.filter((_, j) => j !== i));
                    markPricingDirty(true);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 flex h-7 items-center rounded px-2 text-xs text-l3 hover:bg-white/5 hover:text-l1"
            onClick={() => {
              setPricingRows([
                ...pricingRows,
                { prefix: "", input: "", output: "" },
              ]);
              markPricingDirty(true);
            }}
          >
            + 添加模型
          </button>
        </div>
      </Section>

      <Section
        title="集成"
        open={!collapsed.integration}
        onToggle={() => toggleSection("integration")}
      >
        <Row label="brew 镜像" hint="安装/更新走清华 TUNA 镜像">
          <Toggle
            label="brew 镜像"
            checked={settings?.brewMirror ?? false}
            onChange={(checked) => patch({ brewMirror: checked })}
          />
        </Row>

        <Row
          label="AI 专用配置"
          hint="◈ 生成（提交信息/摘要/PR）固定走此配置，建议选快模型；默认自动=最近使用"
        >
          <select
            className={fieldFixed}
            value={settings?.aiProfileId ?? ""}
            onChange={(e) => patch({ aiProfileId: e.target.value })}
          >
            <option value="">自动（最近使用）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.agent}
                {p.models[0] ? ` · ${p.models[0]}` : ""}）
              </option>
            ))}
          </select>
        </Row>

        {AI_FN_ROWS.map((fn) => (
          <Row
            key={fn.key}
            label={fn.label}
            hint="留空则跟随默认（上方「AI 专用配置」）"
          >
            <select
              className={fieldFixed}
              value={settings?.aiProfiles?.[fn.key] ?? ""}
              onChange={(e) => patchAiFnProfile(fn.key, e.target.value)}
            >
              <option value="">跟随默认</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.agent}
                  {p.models[0] ? ` · ${p.models[0]}` : ""}）
                </option>
              ))}
            </select>
          </Row>
        ))}

        <Row
          label="外部终端"
          hint="对话页「⇗ 外部恢复」使用的终端应用，立即生效"
        >
          <select
            className={fieldFixed}
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

        <Row
          label="精确注意力标记（Claude Code）"
          hint="开启后会向 ~/.claude/settings.json 写入 hooks 配置（写入前自动备份，仅合并 hooks 段、不动其他配置），注意力点由 Claude 事件实时驱动，比默认的会话尾部推断更准；关闭即移除 hooks 并回退推断模式"
        >
          <Toggle
            label="精确注意力标记（Claude Code）"
            checked={settings?.claudeHooksAttention ?? false}
            onChange={(checked) => void toggleClaudeHooks(checked)}
          />
        </Row>
      </Section>

      <Section
        title="更新"
        open={appUpdate ? true : !collapsed.update}
        onToggle={() => toggleSection("update")}
        badge={
          // 有新版本时强制展开并在标题加标记，避免静默检查结果无人感知
          appUpdate ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded bg-inset px-1.5 py-0.5 text-xs font-normal text-l3">
              <span className="size-1.5 rounded-full bg-ok-text" />
              v{appUpdate.version} 可更新
            </span>
          ) : undefined
        }
      >
        <div className="py-3">
          {appUpdate ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm text-l2">
                  发现新版本{" "}
                  <span className="text-l1">v{appUpdate.version}</span>
                  <span className="ml-2 text-xs text-l4">
                    当前 v{appUpdate.currentVersion}
                  </span>
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
              <span className="text-xs text-l4">
                未发现新版本（启动时已自动检查）
              </span>
              <button
                onClick={() => checkAppUpdate()}
                className={`ml-auto ${rowActionClass}`}
              >
                重新检查
              </button>
            </div>
          )}
        </div>
      </Section>

      <Section
        title="诊断"
        open={!collapsed.diag}
        onToggle={() => toggleSection("diag")}
      >
        <div className="mt-3 flex items-center gap-3 rounded bg-strip p-3">
          <div className="min-w-0">
            <p className="text-sm text-l2">Windows 诊断包</p>
            <p className="mt-0.5 text-xs leading-5 text-l4">
              汇总系统、WebView2、显卡/WebGL、输入法、功能开关、应用日志与子进程生命周期；不采集环境变量，参数和日志会脱敏
            </p>
          </div>
          <button
            onClick={exportDiagnosticsBundle}
            disabled={diagnosticsExporting}
            className="ml-auto h-8 shrink-0 rounded border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {diagnosticsExporting ? "正在采集…" : "导出诊断包"}
          </button>
        </div>
        <div className="py-3">
          <div className="group mb-2 flex items-center gap-2">
            <span className="text-xs text-l4">
              最近 100 条应用日志（进程内缓冲，重启即清空）
            </span>
            {/* 诊断是低频区：行内按钮 hover 才现，Tab 聚焦同样显示 */}
            <button
              onClick={loadLogs}
              className={`ml-auto rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 ${hoverRevealClass}`}
            >
              刷新
            </button>
            <button
              onClick={copyLogs}
              disabled={logs.length === 0}
              className={`rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50 ${hoverRevealClass}`}
            >
              复制全部
            </button>
            <button
              onClick={async () => {
                setError(null);
                try {
                  const path = await invoke<string>("export_app_log");
                  setNotice(`已导出：${path}`);
                  setTimeout(() => setNotice(null), 4000);
                } catch (e) {
                  setError(String(e));
                }
              }}
              disabled={logs.length === 0}
              title="导出为 txt 到 ~/Downloads/ccode-exports/，反馈问题时发给开发者"
              className={`rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50 ${hoverRevealClass}`}
            >
              导出
            </button>
            <button
              onClick={clearLogs}
              disabled={logs.length === 0}
              className={`rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50 ${hoverRevealClass}`}
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
                  <span className="text-l4">
                    {l.ts.replace("T", " ").replace("Z", "")}{" "}
                  </span>
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
    </PageFrame>
  );
}
