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
  Checkbox,
  Toggle,
  secondaryActionClass,
} from "../components/PageFrame";
import { captureDecision, comboLabel, PAGE_HOTKEY_DEFS } from "../hotkeys";
import {
  NAV_CAPSULE_ITEM_IDS,
  normalizeNavCapsuleDelay,
  normalizeNavCapsuleDisplayMode,
  normalizeNavCapsuleVisibleItems,
  resolveStartupNavMode,
  type NavCapsuleItemId,
} from "../nav-capsule";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { StorageEntryDto } from "../types";
import { AGENTS } from "../types";
import { getVersion } from "@tauri-apps/api/app";
import { collectFrontendDiagnostics } from "../diagnostics";

/** 七套深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
import {
  XTERM_PALETTES,
  PALETTE_PREVIEW_KEYS,
  PALETTE_LIST,
  resolvePaletteId,
} from "../terminal-palettes";
import { THEMES, isLightTheme } from "../themes";
import { NAV_GROUPS, NAV_BOTTOM } from "../navigation";

// 调色板清单单一出处在 ../terminal-palettes（PALETTE_LIST，含亮暗标记）

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
  { key: "digest", label: "提炼接力 / 评审沉淀" },
  { key: "conflict", label: "冲突建议" },
  { key: "translate", label: "翻译" },
];

const NAV_CAPSULE_SETTING_ITEMS: { id: NavCapsuleItemId; label: string }[] = [
  { id: "quick-chat", label: "快速开聊" },
  ...NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => ({ id: item.id as NavCapsuleItemId, label: item.label })),
  ),
  ...NAV_BOTTOM.map((item) => ({
    id: item.id as NavCapsuleItemId,
    label: item.label,
  })),
];

/** 诊断日志条目（与后端 logbuf::LogEntryDto 对应） */
type LogEntry = { ts: string; level: string; source: string; message: string };

/** 精确注意力标记支持清单条目（与后端 hooks::HookSupportDto 对应） */
type HookSupport = {
  agent: string;
  supported: boolean;
  note?: string | null;
  configPath?: string | null;
};

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
/** 字节数白话：设置页「数据与存储」用（1 位小数，KB 起跳） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

const DEFAULT_COLLAPSED: Record<string, boolean> = {
  startup: true,
  storage: true,
  about: true,
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
  active = true,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}) {
  if (!active) return null;
  // 选中的分区是当前工作面，不能被旧的折叠记忆或标题点击折成空白。
  const effectiveOpen = active || open;
  return (
    <section className="mt-6 first:mt-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={effectiveOpen}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium text-l1 transition-colors hover:bg-hover"
      >
        <span className="w-3 text-xs text-l4">{effectiveOpen ? "▾" : "▸"}</span>
        {title}
        {badge}
      </button>
      {effectiveOpen && <div>{children}</div>}
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
    <div className="grid grid-cols-[minmax(180px,1fr)_auto] items-center gap-x-5 py-3">
      <div className="min-w-0">
        <div className="text-sm text-l2">{label}</div>
        {hint && <p className="mt-0.5 max-w-lg text-micro leading-4 text-l4">{hint}</p>}
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
  conflictsWith,
  onSave,
}: {
  /** 当前绑定（"" = 已禁用） */
  value: string;
  defaultValue: string;
  /** 其余在用的绑定值，用于防冲突（空串不计） */
  conflictsWith: string[];
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
      const d = captureDecision(e, conflictsWith);
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
  }, [listening, conflictsWith, onSave]);

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
      {conflict && <span className="text-xs text-err-text">与其他快捷键冲突</span>}
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
  const [activeSection, setActiveSection] = useState("appearance");
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
  // 生效配置快照导出进行态（排查九家 agent 配置漂移用）
  const [configDumpExporting, setConfigDumpExporting] = useState(false);
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
  // 应用版本（「关于」分区）：Tauri 从 tauri.conf.json 取，与打包产物一致
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  // 精确注意力标记支持清单（九家全列出，支持与否与备注以后端注册表为准）
  const [hookSupport, setHookSupport] = useState<HookSupport[]>([]);
  useEffect(() => {
    invoke<HookSupport[]>("hooks_attention_support")
      .then(setHookSupport)
      .catch(() => {});
  }, []);
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

  // 应用数据占用：展开「数据与存储」时读一次（递归求目录大小，不适合常驻轮询）
  const [storage, setStorage] = useState<StorageEntryDto[] | null>(null);
  useEffect(() => {
    if (
      visible &&
      (activeSection === "storage" || !collapsed.storage) &&
      storage === null
    )
      invoke<StorageEntryDto[]>("app_storage_usage")
        .then(setStorage)
        .catch(() => setStorage([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeSection, collapsed.storage]);

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

  /** 精确注意力标记开关：走专用命令（写/移除该 agent 的 hooks 配置 + 记设置），
      不走普通 patch——失败时设置不落库，避免开关显示与实际安装不一致 */
  const [hooksBusy, setHooksBusy] = useState<string | null>(null);
  async function toggleHooks(agent: string, label: string, enabled: boolean) {
    if (hooksBusy) return;
    setError(null);
    setHooksBusy(agent);
    try {
      const s = await invoke<AppSettings>("set_hooks_attention", {
        agent,
        enabled,
      });
      useAppStore.setState({ settings: s });
      const target = hookSupport.find((h) => h.agent === agent)?.configPath;
      setNotice(
        enabled
          ? `已开启：${label} hooks 已写入 ${target ?? "其配置文件"}`
          : `已关闭：${label} hooks 已移除`,
      );
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setHooksBusy(null);
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

  // 生效配置快照：一键落盘 ~/Downloads/ccode-exports/（口径同诊断包导出）；
  // 设置页无项目语境，projectRoot 传 null（workspaceSettings 段不产出）
  async function exportEffectiveConfig() {
    if (configDumpExporting) return;
    setConfigDumpExporting(true);
    setError(null);
    try {
      const path = await invoke<string>("export_effective_config", {
        projectRoot: null,
      });
      setNotice(`配置快照已导出：${path}`);
      setTimeout(() => setNotice(null), 5000);
    } catch (e) {
      setError(String(e));
    } finally {
      setConfigDumpExporting(false);
    }
  }

  async function openStorageEntry(path: string) {
    setError(null);
    try {
      // 条目既可能是文件也可能是目录；统一在系统文件管理器中定位，
      // 避免把目录交给默认应用后看起来像按钮无效。
      await revealItemInDir(path);
    } catch (e) {
      setError(`无法打开此位置：${String(e)}`);
    }
  }

  return (
    <PageFrame width="settings">
      <PageHeader title="设置" meta="外观、终端与应用集成" />
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      <div className="grid min-w-0 grid-cols-[150px_minmax(0,1fr)] gap-8">
        <nav aria-label="设置分区" className="sticky top-14 self-start">
          <p className="mb-2 px-2 text-micro uppercase tracking-wider text-l4">
            设置
          </p>
          <div className="space-y-0.5">
            {[
              ["appearance", "外观"],
              ["startup", "启动行为"],
              ["hotkeys", "快捷键"],
              ["stats", "统计"],
              ["integration", "集成"],
              ["update", "更新"],
              ["diag", "诊断"],
              ["storage", "数据与存储"],
              ["about", "关于"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setActiveSection(id);
                  setCollapsed((prev) => {
                    if (!prev[id]) return prev;
                    const next = { ...prev, [id]: false };
                    try {
                      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
                    } catch {}
                    return next;
                  });
                }}
                className={`flex h-8 w-full items-center rounded-md px-2 text-left text-sm transition-colors ${
                  activeSection === id
                    ? "bg-rail-sel font-medium text-l1"
                    : "text-l3 hover:bg-hover hover:text-l1"
                }`}
              >
                {label}
                {id === "update" && appUpdate && (
                  <span className="ml-auto size-1.5 rounded-full bg-ok-text" />
                )}
              </button>
            ))}
          </div>
        </nav>
        <div className="min-w-0">

      <Section
        title="外观"
        active={activeSection === "appearance"}
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
                <span className="mb-1 flex h-8 overflow-hidden rounded-sm">
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
          {/* Agent TUI 只在启动时探测一次终端底色（OSC 11），热切换主题后运行中会话保持
              旧配色——无条件常驻说明：按 liveSessions 门控会在页面重载后（标签恢复为占位、
              登记清空）恰好需要提示时缺席（2026-08-24 实测教训） */}
          <div className="mt-2 text-micro text-l4">
            Agent 会话的界面配色按启动时的终端底色确定，切换主题后运行中的会话保持旧配色，
            重启会话后与新主题一致
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
          hint="立即生效；未安装的字体可一键装"
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
                    className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 font-mono text-xs text-l3"
                  >
                    {fontInstallOutput || "安装中，等待输出…"}
                  </pre>
                )}
                {!fontInstalling && fontInstallResult && (
                  <div className="rounded-sm bg-strip p-2 text-xs text-l2">
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
                  className="h-7 shrink-0 rounded-sm border border-cta-bd bg-cta px-2.5 text-xs text-cta-text hover:brightness-110 disabled:opacity-50"
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
          {/* 只列出与当前主题亮暗匹配的四套：浅色主题配深色向 ANSI 会让 white/brightWhite
              在近白底上隐形，不给用户配出不可读组合的机会。存的值不符时按 twin 现算生效值。 */}
          {(() => {
            const themeIsLight = isLightTheme(settings?.theme);
            const stored = settings?.terminalPalette;
            const effective = resolvePaletteId(stored, themeIsLight);
            const options = PALETTE_LIST.filter((p) => p.light === themeIsLight);
            return (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  {options.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => patch({ terminalPalette: pl.id })}
                      title={pl.name}
                      className={`rounded-md border p-1.5 text-xs ${
                        effective === pl.id
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
                {stored && stored !== effective && (
                  <div className="text-micro text-l4">
                    当前主题是{themeIsLight ? "浅色" : "深色"}，已自动切换到配对的
                    {themeIsLight ? "浅色" : "深色"}调色板
                  </div>
                )}
              </div>
            );
          })()}
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
          hint="agent 转为待确认且窗口未聚焦时发系统通知（同一标签 30 秒内最多一条）；首次发送需允许系统通知权限"
        >
          <Toggle
            label="长任务 OS 通知"
            checked={settings?.notificationsEnabled ?? true}
            onChange={(checked) => patch({ notificationsEnabled: checked })}
          />
        </Row>

        <Row
          label="聊天页显示状态栏"
          hint="聊天页底部显示模型/目录/git/token 状态栏；关闭后隐藏但保留占位，聊天⇄终端切换不改变终端尺寸、不闪烁"
        >
          <Toggle
            label="聊天页显示状态栏"
            checked={settings?.statusBarInChat ?? true}
            onChange={(checked) => patch({ statusBarInChat: checked })}
          />
        </Row>
      </Section>

      {/* 快捷键：点击绑定钮进入录制态，按下新组合即保存；空串 = 禁用 */}
      <Section
        title="启动行为"
        active={activeSection === "startup"}
        open={!collapsed.startup}
        onToggle={() => toggleSection("startup")}
      >
        <Row
          label="想法期只读保护"
          hint="聊想法时不让 agent 改文件（支持的 CLI 走进程级保护）"
        >
          {/* v3.66 当时定「设置页不加行」，前提是只有一个开关点；
              现在它影响多条讨论路径，用户在卡片区之外找不到它（v3.88 补） */}
          <Toggle
            checked={settings?.discussReadonly ?? true}
            onChange={(v) => patch({ discussReadonly: v })}
            label="想法期只读保护"
          />
        </Row>
        <Row label="启动时进入" hint="下次启动生效">
          <select
            className={fieldFixed + " w-32"}
            value={settings?.startPage ?? "workbench"}
            onChange={(e) => patch({ startPage: e.target.value })}
          >
            {PAGE_HOTKEY_DEFS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="默认导航形态"
          hint="仅影响下次启动；运行中仍可通过侧栏按钮或 ⌘\\ 临时切换"
        >
          <select
            className={fieldClass + " w-52"}
            value={resolveStartupNavMode(
              settings?.startupNavMode,
              localStorage.getItem("ccode.navCollapsed") === "1",
            )}
            onChange={(e) =>
              void patch({
                startupNavMode: e.target.value as
                  | "expanded"
                  | "collapsed"
                  | "hidden",
              })
            }
          >
            <option value="expanded">展开侧栏</option>
            <option value="collapsed">图标侧栏</option>
            <option value="hidden">完全隐藏 + 顶部导航胶囊</option>
          </select>
        </Row>
        <Row
          label="顶部导航自动隐藏"
          hint="完全隐藏时，鼠标移动到上下文栏下方即可呼出顶部导航"
        >
          <select
            className={fieldClass + " w-28"}
            value={normalizeNavCapsuleDelay(settings?.navCapsuleHideDelayMs)}
            onChange={(e) =>
              void patch({ navCapsuleHideDelayMs: Number(e.target.value) })
            }
          >
            <option value={500}>0.5 秒</option>
            <option value={1000}>1 秒</option>
            <option value={2000}>2 秒</option>
            <option value={5000}>5 秒</option>
          </select>
        </Row>
        <Row
          label="顶部导航内容"
          hint="完全隐藏时控制胶囊显示符号、文字，设置修改后立即生效"
        >
          <select
            className={fieldClass + " w-40"}
            value={normalizeNavCapsuleDisplayMode(settings?.navCapsuleDisplayMode)}
            onChange={(e) =>
              void patch({
                navCapsuleDisplayMode: e.target.value as
                  | "both"
                  | "icons"
                  | "labels",
              })
            }
          >
            <option value="both">符号 + 文字</option>
            <option value="icons">仅显示符号</option>
            <option value="labels">仅显示文字</option>
          </select>
        </Row>
        <Row
          label="顶部导航显示项目"
          hint="恢复侧栏始终保留；隐藏当前页面时会临时保留该入口"
          extra={
            <div className="grid grid-cols-2 gap-x-5 gap-y-2 rounded-md bg-inset p-3 sm:grid-cols-3">
              {NAV_CAPSULE_SETTING_ITEMS.map((item) => {
                const selected = normalizeNavCapsuleVisibleItems(
                  settings?.navCapsuleVisibleItems,
                ).includes(item.id);
                return (
                  <Checkbox
                    key={item.id}
                    checked={selected}
                    label={item.label}
                    onChange={(checked) => {
                      const current = normalizeNavCapsuleVisibleItems(
                        settings?.navCapsuleVisibleItems,
                      );
                      const next = checked
                        ? [...new Set([...current, item.id])]
                        : current.filter((id) => id !== item.id);
                      void patch({ navCapsuleVisibleItems: next });
                    }}
                  />
                );
              })}
            </div>
          }
        >
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-l3 hover:bg-hover hover:text-l1"
            onClick={() => void patch({ navCapsuleVisibleItems: [...NAV_CAPSULE_ITEM_IDS] })}
          >
            全部显示
          </button>
        </Row>
      </Section>

      <Section
        title="快捷键"
        active={activeSection === "hotkeys"}
        open={!collapsed.hotkeys}
        onToggle={() => toggleSection("hotkeys")}
      >
        {/* 全部在用的绑定（命令面板/侧栏/九页切），供各行录制时互判冲突 */}
        {(() => {
          const palette = settings?.hotkeyPalette ?? "mod+k";
          const chrome = settings?.hotkeyHideChrome ?? "mod+\\";
          const pageCombo = (id: string) =>
            settings?.hotkeyPages?.[id] ??
            PAGE_HOTKEY_DEFS.find((p) => p.id === id)?.combo ??
            "";
          const pageCombos = PAGE_HOTKEY_DEFS.map((p) => pageCombo(p.id));
          return (
            <>
              <Row
                label="页面切换"
                hint="按侧栏顺序切换页面；关闭后下面九个绑定全部不生效"
              >
                <Toggle
                  checked={settings?.hotkeyPageSwitch !== false}
                  onChange={(v) => void patch({ hotkeyPageSwitch: v })}
                  label="页面切换"
                />
              </Row>
              <div className="mb-1 mt-2 text-xs font-medium text-l3">页面快捷键</div>
              <div className="flex w-full max-w-xl flex-col gap-1 rounded-md bg-strip p-1">
                {PAGE_HOTKEY_DEFS.map((p) => (
                  <span
                    key={p.id}
                    className="flex min-h-9 items-center justify-between gap-4 rounded-sm px-2 py-1 hover:bg-hover"
                  >
                    <span className="min-w-20 shrink-0 text-sm text-l2">
                      {p.label}
                    </span>
                    <HotkeyCapture
                      value={pageCombo(p.id)}
                      defaultValue={p.combo}
                      conflictsWith={[
                        palette,
                        chrome,
                        ...PAGE_HOTKEY_DEFS.filter((x) => x.id !== p.id).map(
                          (x) => pageCombo(x.id),
                        ),
                      ]}
                      onSave={(combo) =>
                        void patch({
                          hotkeyPages: {
                            ...(settings?.hotkeyPages ?? {}),
                            [p.id]: combo,
                          },
                        })
                      }
                    />
                  </span>
                ))}
              </div>
              <div className="mb-1 mt-4 text-xs font-medium text-l3">全局快捷键</div>
              <Row label="命令面板" hint="呼出页面跳转 / 主题切换 / 侧栏显隐">
                <HotkeyCapture
                  value={palette}
                  defaultValue="mod+k"
                  conflictsWith={[chrome, ...pageCombos]}
                  onSave={(combo) => void patch({ hotkeyPalette: combo })}
                />
              </Row>
              <Row label="隐藏 / 显示侧栏" hint="执行态：界面只剩工作内容">
                <HotkeyCapture
                  value={chrome}
                  defaultValue="mod+\\"
                  conflictsWith={[palette, ...pageCombos]}
                  onSave={(combo) => void patch({ hotkeyHideChrome: combo })}
                />
              </Row>
            </>
          );
        })()}
      </Section>

      <Section
        title="统计"
        active={activeSection === "stats"}
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
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-err-text"
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
            className="mt-2 flex h-7 items-center rounded-sm px-2 text-xs text-l3 hover:bg-hover hover:text-l1"
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
        active={activeSection === "integration"}
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

        {hookSupport.map((h) => {
          const label = AGENTS.find((a) => a.id === h.agent)?.label ?? h.agent;
          const baseHint = h.supported
            ? `比默认推断更准；会写入 ${h.configPath ?? `${label} 配置`}（自动备份，不影响已有配置）`
            : "暂不支持";
          return (
            <Row
              key={h.agent}
              label={`精确注意力标记（${label}）`}
              hint={h.note ? `${baseHint}；${h.note}` : baseHint}
            >
              {h.supported ? (
                <Toggle
                  label={`精确注意力标记（${label}）`}
                  checked={settings?.hooksAttention?.[h.agent] ?? false}
                  onChange={(checked) => void toggleHooks(h.agent, label, checked)}
                />
              ) : (
                <span className="pointer-events-none opacity-40">
                  <Toggle
                    label={`精确注意力标记（${label}）`}
                    checked={false}
                    onChange={() => {}}
                  />
                </span>
              )}
            </Row>
          );
        })}
      </Section>

      <Section
        title="更新"
        active={activeSection === "update"}
        open={appUpdate ? true : !collapsed.update}
        onToggle={() => toggleSection("update")}
        badge={
          // 有新版本时强制展开并在标题加标记，避免静默检查结果无人感知
          appUpdate ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-inset px-1.5 py-0.5 text-xs font-normal text-l3">
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
                  className="ml-auto h-8 rounded-sm border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {installing ? "下载安装中…" : "下载并安装"}
                </button>
              </div>
              {appUpdate.body && (
                <div className="max-h-48 overflow-auto whitespace-pre-line rounded-sm bg-inset p-2 text-xs leading-5 text-l3">
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
        active={activeSection === "diag"}
        open={!collapsed.diag}
        onToggle={() => toggleSection("diag")}
      >
        <div className="mt-3 flex items-center gap-3 rounded-sm bg-strip p-3">
          <div className="min-w-0">
            <p className="text-sm text-l2">Windows 诊断包</p>
            <p className="mt-0.5 text-xs leading-5 text-l4">
              打包系统与运行信息供排查；已脱敏，不含环境变量
            </p>
          </div>
          <button
            onClick={exportDiagnosticsBundle}
            disabled={diagnosticsExporting}
            className="ml-auto h-8 shrink-0 rounded-sm border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {diagnosticsExporting ? "正在采集…" : "导出诊断包"}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-sm bg-strip p-3">
          <div className="min-w-0">
            <p className="text-sm text-l2">生效配置快照</p>
            <p className="mt-0.5 text-xs leading-5 text-l4">
              应用设置、九家配置清单与能力表的当前生效值，排查配置漂移用；已脱敏，不含密钥
            </p>
          </div>
          <button
            onClick={exportEffectiveConfig}
            disabled={configDumpExporting}
            className="ml-auto h-8 shrink-0 rounded-sm border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {configDumpExporting ? "正在生成…" : "导出生效配置快照"}
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
              className={`ml-auto rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover ${hoverRevealClass}`}
            >
              刷新
            </button>
            <button
              onClick={copyLogs}
              disabled={logs.length === 0}
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
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
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
            >
              导出
            </button>
            <button
              onClick={clearLogs}
              disabled={logs.length === 0}
              className={`rounded-sm px-2 py-0.5 text-xs text-l2 hover:bg-hover disabled:opacity-50 ${hoverRevealClass}`}
            >
              清空
            </button>
          </div>
          {logs.length === 0 ? (
            <p className="text-xs text-l4">暂无日志</p>
          ) : (
            <div className="max-h-64 overflow-auto rounded-sm bg-inset p-2 font-mono text-xs leading-5">
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

      <Section
        title="数据与存储"
        active={activeSection === "storage"}
        open={!collapsed.storage}
        onToggle={() => toggleSection("storage")}
      >
        {/* 用户此前完全不知道 Ccode 在硬盘上占了多少、存在哪（v3.88 补） */}
        {storage === null ? (
          <p className="py-2 text-xs text-l4">统计中…</p>
        ) : (
          <ul className="space-y-1">
            {storage.map((e) => (
              <li key={e.path} className="flex items-center gap-2 rounded-md bg-strip px-2 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-l2">
                    {e.label}
                  </span>
                  <span
                    className="block truncate font-mono text-micro text-l4"
                    title={e.path}
                  >
                    {e.path}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-l3">
                  {e.exists ? formatBytes(e.bytes) : "—"}
                </span>
                <button
                  type="button"
                  disabled={!e.exists}
                  onClick={() => void openStorageEntry(e.path)}
                  title="在系统文件管理器中定位"
                  className={`${secondaryActionClass} shrink-0 disabled:opacity-40`}
                >
                  定位
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="pt-2 text-micro text-l4">
          快照 / 备份 / 缓存可以直接删，配置与索引别手动删。
        </p>
      </Section>

      <Section
        title="关于"
        active={activeSection === "about"}
        open={!collapsed.about}
        onToggle={() => toggleSection("about")}
      >
        <Row label="版本" hint="">
          <span className="font-mono text-xs text-l2">{appVersion ?? "…"}</span>
        </Row>
        <Row label="项目主页" hint="MIT 许可">
          <button
            type="button"
            className={secondaryActionClass}
            onClick={() =>
              void openUrl("https://github.com/hongtongzhou-design/ccode")
            }
          >
            在浏览器打开
          </button>
        </Row>
      </Section>
        </div>
      </div>
    </PageFrame>
  );
}
