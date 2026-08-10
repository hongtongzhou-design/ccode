import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import { confirmDialog } from "../components/ConfirmDialog";
import ContextMenu from "../components/ContextMenu";
import FileTree from "../components/FileTree";
import GitPanel from "../components/GitPanel";
import HandoffPicker, { type HandoffSource } from "../components/HandoffPicker";
import { LoadingRows } from "../components/PageFrame";
import ProjectRail from "../components/ProjectRail";
import WorkspaceReviewView from "../components/WorkspaceReviewView";
import { renderTaskMd } from "../pipeline-start";
import { ORGANIZE_NOTES_PROMPT } from "../pipeline-presets";
import { XTERM_PALETTES } from "../terminal-palettes";
import { isSoftwareWebGL } from "../diagnostics";
import {
  attentionTransition,
  debounceAllows,
  notifyBody,
  notifyTitle,
} from "../notify";
import {
  parseRecoverableTerminalState,
  serializeRecoverableTerminalState,
  TERMINAL_TABS_STORAGE_KEY,
} from "../terminal-tab-persistence";
import type { RunOverviewInput } from "../run-overview";
import type {
  ChatMessageDto,
  ConversationPageDto,
  ProjectConfigReadDto,
  ProjectDto,
  SessionMetaDto,
  SkillDto,
  McpServerDto,
  WorkspaceDto,
  WorkspaceHealthDto,
} from "../types";
import type { PdfActionResult } from "../components/PdfPreview";

// Monaco 体积大，首次打开文件预览时才加载
const FilePreviewEditor = lazy(() => import("../components/FilePreviewEditor"));
// pdf.js 同样拆懒加载 chunk，首次打开 PDF 预览时才加载
const PdfPreview = lazy(() => import("../components/PdfPreview"));
// mammoth 拆懒加载 chunk，首次打开 docx 预览时才加载
const DocxPreview = lazy(() => import("../components/DocxPreview"));

type PtyKind = "agent" | "shell";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 归一化后判断 path 是否落在 base 内（含相等），与 FileTree/ProjectRail 的口径一致 */
function pathWithin(path: string, base: string): boolean {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return p === b || p.startsWith(`${b}/`);
}

/** 标签页状态：由 TerminalView 上报，标签条 / 首页收件箱镜像（terminalRunInputs）/ 工作树根目录都用它 */
interface TabStatus {
  title: string;
  /** 有存活 PTY（agent 或 shell） */
  alive: boolean;
  /** agent 正在运行（关闭前需要确认） */
  running: boolean;
  /** 当前接的是登录 shell（agent 退出回落或手动打开） */
  shell: boolean;
  agentId: string;
  profileId: string;
  model: string;
  cwd: string;
  /** 当前 PTY id（可见性门控用；无存活 PTY 时为 null） */
  ptyId: string | null;
  /** 会话尾部状态（P3c 注意力标记）；无联动/shell/已退出/未知时为 null */
  attention: "done" | "working" | "confirm" | null;
  /** shell 模式下存在可恢复的会话（标签条 ⋯ 菜单「⟳ 恢复会话」可用性） */
  canResume: boolean;
  /** 当前或最近一次关联的会话 id；只用于标签恢复元数据，不含会话文件内容。 */
  sessionId: string | null;
}

/** TerminalView 暴露给标签条 ⋯ 菜单的动作表（回调经 ref 转发，始终最新） */
export interface FocusTabActions {
  stop: () => void;
  resume: () => void;
  openConversationPage: () => void;
  search: () => void;
  modify: () => void;
}

/** TerminalView 上报的当前对话联动数据（右侧「对话」页签渲染用） */
interface SessionLinkState {
  file: string | null;
  sessionId: string | null;
  title: string | null;
  agentId: string | null;
  state: "idle" | "detecting" | "linked" | "timeout";
  conv: ChatMessageDto[];
}

const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

const RIGHT_PANEL_WIDTH_KEY = "ccode.terminalRightWidth";
const RIGHT_PANEL_DEFAULT_WIDTH = 460;
const RIGHT_PANEL_MIN_WIDTH = 360;
const RIGHT_PANEL_MAX_WIDTH = 820;
// 分屏：左 pane 宽度百分比的本地记忆（分屏开关状态本身不持久化）
const SPLIT_PCT_KEY = "ccode.terminalSplitPct";
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;
const clampSplitPct = (pct: number) =>
  Math.min(SPLIT_MAX_PCT, Math.max(SPLIT_MIN_PCT, pct));
const RIGHT_TABS = [
  { key: "dialogue", label: "对话", symbol: "◔" },
  { key: "preview", label: "文件", symbol: "▤" },
  { key: "git", label: "改动", symbol: "⌘" },
] as const;
type RightTab = (typeof RIGHT_TABS)[number]["key"];

/** shell 单引号转义（向 PTY 写 cd 命令用） */
const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** 发系统通知：macOS 首次发送前必须显式申请权限（系统级弹窗，仅首次）；被拒则静默跳过。
 *  带「去处理」动作按钮（ccode.attention，App.tsx 注册）；extra 携带 tabId/cwd/kind，
 *  onAction 路由：已完成且 cwd 是任务工作区 → 直达评审覆盖层；待确认/其余 → 聚焦对应标签。 */
async function fireAttentionNotification(
  title: string,
  body: string,
  extra: { tabId: string; cwd: string; kind: "confirm" | "done" },
) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ title, body, actionTypeId: "ccode.attention", extra });
}

/** 七套深色 + 七套浅色主题对应的 xterm 底色/前景（取自 App.css 各主题调色板；调色板其余部分共享）。
 *  浅色主题下 ANSI 16 色预设仍偏深色向，用户可在设置页调色板里另行选择。 */
const XTERM_BG_FG: Record<string, { background: string; foreground: string }> =
  {
    midnight: { background: "#0e1015", foreground: "#b3b0aa" },
    terracotta: { background: "#2d2d2b", foreground: "#c9c9c4" },
    ayu: { background: "#10141c", foreground: "#bfbdb6" },
    mocha: { background: "#1e1e2e", foreground: "#aeb8dc" },
    neutral: { background: "#111111", foreground: "#c9c9c9" },
    dracula: { background: "#282a36", foreground: "#cfcfc9" },
    shadcn: { background: "#111827", foreground: "#b9b9c0" },
    "midnight-light": { background: "#fdfdfe", foreground: "#3a3f52" },
    "terracotta-light": { background: "#fefcfa", foreground: "#453f3a" },
    "ayu-light": { background: "#fffefd", foreground: "#3f4754" },
    "mocha-light": { background: "#fafbfe", foreground: "#4c4f69" },
    "neutral-light": { background: "#fdfdfd", foreground: "#3a3a3a" },
    "dracula-light": { background: "#fefdff", foreground: "#403a4e" },
    "shadcn-light": { background: "#fefefe", foreground: "#344054" },
  };

/** VS Code Dark+ 风格 16 色调色板（各主题共享，只换底/字色） */
/** 终端 16 色调色板预设已抽至 src/terminal-palettes.ts（设置页预览共享） */

function buildXtermTheme(themeId: string, paletteId?: string) {
  const palette =
    XTERM_PALETTES[paletteId ?? "dark-plus"] ?? XTERM_PALETTES["dark-plus"];
  return {
    ...(XTERM_BG_FG[themeId] ?? XTERM_BG_FG.midnight),
    cursor: "#aeafad",
    selectionBackground: "#264f78",
    ...palette,
  };
}

/** 单个终端：独立持有 xterm 实例、PTY 引用和启动栏状态；隐藏时只 display:none，不杀进程。
 *  memo 化：启动栏自己的状态变化只重渲染本组件，不级联到兄弟标签/文件树/编辑器。 */
const TerminalView = memo(function TerminalView({
  visible,
  primaryFocus = true,
  rightOpen,
  layoutKey,
  gitTotals,
  tabId,
  initialCwd,
  skipSeed,
  initialExtraEnv,
  initialTitle,
  initialAgentId,
  initialProfileId,
  initialModel,
  resumeSessionId,
  autoStart,
  prefillCommand,
  shellOnly,
  initialPrompt: presetPrompt,
  restored,
  externalCwd,
  onConsumeExternalCwd,
  onStatus,
  onSessionUpdate,
  onHandoff,
  focusMode,
  onActions,
  onRestoreComplete,
  onConsumeResume,
}: {
  visible: boolean;
  /** 分屏时只有活跃 pane 绑定窗口级 ⌘F 兜底；xterm 聚焦时的拦截不受影响 */
  primaryFocus?: boolean;
  /** 右侧面板开关影响 xterm 可用宽度，变化时需要重新 fit */
  rightOpen: boolean;
  /** 布局版本号（左栏显隐/专注终端等宽度变化时递增，触发 xterm 重新 fit） */
  layoutKey?: string;
  /** 该标签 cwd 的 git 变更统计（Codex 风：状态行常驻 +N -N） */
  gitTotals?: { add: number; del: number } | null;
  /** 本标签 id（liveSessions 登记用） */
  tabId: string;
  /** 不继承「上次启动」记录（兜底空标签） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建的标签：启动栏 cwd 预填为该目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（如 CCODE_PORT 端口段），launch 时注入 */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名），优先于 profile/agent 名 */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 首次可见时自动启动（会话恢复；有 profile 才启动，否则只预填） */
  autoStart?: boolean;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：挂载后自动开 shell 并执行 prefillCommand（不走 agent 启动流程） */
  shellOnly?: boolean;
  /** 一键开步预填的首条指令：启动时注入 CLI，成功后清除（一次性）；留空 = 不注入 */
  initialPrompt?: string;
  /** 应用重启后恢复出的占位标签；用户明确操作前不启动 PTY。 */
  restored?: boolean;
  /** 最近项目「真进入」：把目标目录注入活动标签的启动栏（TerminalView 消费后清空） */
  externalCwd?: string | null;
  onConsumeExternalCwd?: () => void;
  /** 上报回调带 tabId（父级共享 useCallback，memo 稳定） */
  onStatus: (id: string, s: TabStatus) => void;
  onSessionUpdate: (id: string, s: SessionLinkState) => void;
  /** 「◈ 接力到…」：把当前关联会话交给父级的接力目标选择器 */
  onHandoff?: (source: HandoffSource) => void;
  /** 专注终端：隐藏标签内状态条（动作移到标签条 ⋯ 菜单） */
  focusMode?: boolean;
  /** 向父级注册本标签的动作表（标签条 ⋯ 菜单调用） */
  onActions?: (id: string, a: FocusTabActions) => void;
  onRestoreComplete?: (id: string) => void;
  /** launch 成功接管会话后通知父级清掉标签级 resumeSessionId（之后「启动」不再接旧会话） */
  onConsumeResume?: (id: string) => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const settings = useAppStore((s) => s.settings);
  // 终端创建 effect 依赖 [everVisible]，创建时参数经 ref 取最新设置
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // 设置即时应用：字号与主题色随设置页修改实时生效（scrollback 只对新终端生效）
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings) return;
    term.options.fontSize = settings.terminalFontSize;
    term.options.fontFamily = `'${settings.terminalFontFamily ?? "JetBrains Mono"}', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace`;
    term.options.theme = buildXtermTheme(
      settings.theme,
      settings.terminalPalette,
    );
  }, [settings]);
  // 记住上次启动选择（agent/profile/模型/目录），每个新标签以此为初始值（skipSeed 标签除外）
  const saved = skipSeed
    ? {}
    : (() => {
        try {
          return JSON.parse(
            localStorage.getItem("ccode.lastLaunch") ?? "{}",
          ) as Partial<{
            agentId: string;
            profileId: string;
            model: string;
            cwd: string;
          }>;
        } catch {
          return {};
        }
      })();
  const [agentId, setAgentId] = useState<string>(
    initialAgentId ?? saved.agentId ?? "claude-code",
  );
  const [profileId, setProfileId] = useState(
    initialProfileId ?? saved.profileId ?? "",
  );
  const [model, setModel] = useState(initialModel ?? saved.model ?? "");
  const selectedProfile = profiles.find(
    (p) => p.id === profileId && p.agent === agentId,
  );
  // 模型 combo：下拉开合状态 + 选项来源（profile 预设 + 本 agent 历史，去重）
  const [modelOpen, setModelOpen] = useState(false);
  const modelOptions = useMemo(() => {
    let history: string[] = [];
    try {
      history = JSON.parse(
        localStorage.getItem(`ccode.modelHistory.${agentId}`) ?? "[]",
      ) as string[];
    } catch {
      /* 损坏按空历史 */
    }
    return [
      ...new Set([...(selectedProfile?.models ?? []), ...history]),
    ].filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, selectedProfile, model]);
  const [cwd, setCwd] = useState(initialCwd ?? saved.cwd ?? "~");
  // 一键开步的首条指令：开步预填过就展示编辑框；注入成功即清除（一次性）
  const [promptText, setPromptText] = useState(presetPrompt ?? "");
  const [showPrompt, setShowPrompt] = useState(!!presetPrompt);
  const [running, setRunning] = useState(false); // agent 正在运行
  const [shellActive, setShellActive] = useState(false); // 当前接的是 shell
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 启动栏收缩：空闲时完整展示，启动成功后自动收成一行状态条（「修改」可重新展开）
  const [barExpanded, setBarExpanded] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const ptyKindRef = useRef<PtyKind | null>(null);
  const unlistenRef = useRef<(() => void)[]>([]);

  // —— 输出搜索（SearchAddon）：搜索条只作用于本标签的 xterm 实例 ——
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [terminalActionMenu, setTerminalActionMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  /** xterm 画布内的匹配高亮色（与主题无关，参照 VS Code Dark+ 查找高亮） */
  const SEARCH_OPTS = {
    decorations: {
      matchBackground: "#3a5a8a",
      matchOverviewRuler: "#3a5a8a",
      activeMatchBackground: "#5a7ba8",
      activeMatchColorOverviewRuler: "#5a7ba8",
    },
  };

  const findNext = useCallback(
    (q?: string) => {
      const query = q ?? searchQuery;
      if (query) searchRef.current?.findNext(query, SEARCH_OPTS);
    },
    // SEARCH_OPTS 为渲染期常量，无需入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchQuery],
  );

  const findPrev = useCallback(() => {
    if (searchQuery) searchRef.current?.findPrevious(searchQuery, SEARCH_OPTS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  // 切走标签（或整页隐藏）时收起搜索条，避免隐藏标签残留查找态
  useEffect(() => {
    if (!visible) {
      setSearchOpen(false);
      setTerminalActionMenu(null);
    }
  }, [visible]);

  // 搜索条打开时聚焦输入框并选中已有文本
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.select();
  }, [searchOpen]);

  // Cmd/Ctrl+F 呼出搜索条：只挂当前可见且活跃的 pane，保证只作用于活跃终端。
  // 终端聚焦时按键经 xterm 的 customKeyEventHandler 拦截（见创建 effect），这里兜底页面其余焦点。
  useEffect(() => {
    if (!visible || !primaryFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        // Monaco 编辑器（文件预览）有自己的查找组件，不劫持
        if (e.target instanceof Element && e.target.closest(".monaco-editor"))
          return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, primaryFocus]);

  // —— 当前对话联动（SessionLink）：轮询在本地，展示数据上报给页面级右侧面板 ——
  const [sessionFile, setSessionFile] = useState<string | null>(null);
  const [linkedSessionId, setLinkedSessionId] = useState<string | null>(null);
  const [linkedSessionTitle, setLinkedSessionTitle] = useState<string | null>(
    null,
  );
  const [linkState, setLinkState] = useState<SessionLinkState["state"]>("idle");
  const [conv, setConv] = useState<ChatMessageDto[]>([]);
  const lastResumeRef = useRef<string | null>(null);
  const linkCtxRef = useRef<{
    agentId: string;
    cwd: string;
    hint: string | null;
    filePath: string | null;
    /** 锁定的会话 id（liveSessions 登记用） */
    sessionId: string | null;
  } | null>(null);
  const linkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const linkStartedAtRef = useRef(0);
  const setLiveSession = useAppStore((s) => s.setLiveSession);
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setPage = useAppStore((s) => s.setPage);

  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [skillCount, setSkillCount] = useState(0);
  // 当前 agent 已启用的技能清单（技能页开关同步）；点击 pill 展开，一键使用
  const [agentSkills, setAgentSkills] = useState<SkillDto[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  // 当前 agent 已分发的 MCP server 清单（MCP 页开关同步）；点击 pill 展开，一键提及/管理
  const [agentMcps, setAgentMcps] = useState<McpServerDto[]>([]);
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false);

  // 当前 agent 已启用的技能数与清单（技能页开关同步）+ 已分发的 MCP server（MCP 页开关同步）
  useEffect(() => {
    invoke<SkillDto[]>("list_skills")
      .then((all) => {
        const mine = all.filter((s) => s.apps[agentId]);
        setAgentSkills(mine);
        setSkillCount(mine.length);
      })
      .catch(() => {
        setAgentSkills([]);
        setSkillCount(0);
      });
    invoke<McpServerDto[]>("list_mcp_servers")
      .then((all) => setAgentMcps(all.filter((s) => s.apps[agentId])))
      .catch(() => setAgentMcps([]));
  }, [agentId]);

  /** 一键使用技能：运行中注入当前终端输入框（不自动发送）；未启动写进首条指令 */
  function useSkill(name: string) {
    const text = `使用 ${name} 技能：`;
    if (running && activePtyId) {
      invoke("pty_write", { id: activePtyId, data: text }).catch(() => {});
    } else {
      setShowPrompt(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setSkillMenuOpen(false);
  }

  /** 一键提及 MCP server：同技能注入机制（提示 agent 调用其工具；分发变更对新会话生效） */
  function useMcp(name: string) {
    const text = `使用 ${name} 这个 MCP server 提供的工具：`;
    if (running && activePtyId) {
      invoke("pty_write", { id: activePtyId, data: text }).catch(() => {});
    } else {
      setShowPrompt(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setMcpMenuOpen(false);
  }

  /** 技能清单 pill（展开/收缩启动栏共用；up=true 向上弹出，收缩栏在页面顶部须向下） */
  function renderSkillMenu(up: boolean) {
    if (skillCount === 0) return null;
    return (
      <span className="relative">
        <button
          type="button"
          onClick={() => setSkillMenuOpen((v) => !v)}
          title="展开该 agent 已启用的技能清单，点击一键使用"
          aria-expanded={skillMenuOpen}
          className="rounded bg-inset px-1.5 py-0.5 text-l3 hover:bg-seg-sel hover:text-l1"
        >
          ◈ {skillCount} 技能
        </button>
        {skillMenuOpen && (
          <>
            {/* 点击浮层外任意处关闭 */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setSkillMenuOpen(false)}
            />
            {/* 技能清单：一键使用（运行中注入终端输入框，未启动写进首条指令） */}
            <ul
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} z-50 max-h-56 w-64 overflow-auto rounded-md border border-field bg-raised p-1`}
            >
              {agentSkills.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useSkill(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-white/5"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    {s.description && (
                      <span className="truncate text-[11px] text-l4">
                        {s.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </span>
    );
  }

  /** MCP 清单 pill（同技能入口形态；分发到该 agent 的 server 一键提及，底部入口跳 MCP 页管理） */
  function renderMcpMenu(up: boolean) {
    if (agentMcps.length === 0) return null;
    return (
      <span className="relative">
        <button
          type="button"
          onClick={() => setMcpMenuOpen((v) => !v)}
          title="该 agent 已分发的 MCP server 清单（MCP 页管理分发）"
          aria-expanded={mcpMenuOpen}
          className="rounded bg-inset px-1.5 py-0.5 text-l3 hover:bg-seg-sel hover:text-l1"
        >
          ⌗ {agentMcps.length} MCP
        </button>
        {mcpMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setMcpMenuOpen(false)}
            />
            <ul
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} z-50 max-h-56 w-64 overflow-auto rounded-md border border-field bg-raised p-1`}
            >
              {agentMcps.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useMcp(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-white/5"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    <span className="truncate font-mono text-[11px] text-l4">
                      {s.kind === "stdio"
                        ? `${s.command} ${s.args.join(" ")}`
                        : s.url}
                    </span>
                  </button>
                </li>
              ))}
              <li className="border-t border-hairline">
                <button
                  type="button"
                  onClick={() => {
                    setMcpMenuOpen(false);
                    setPage("mcp");
                  }}
                  className="flex w-full rounded px-2 py-1.5 text-left text-[11px] text-l4 hover:bg-white/5 hover:text-l2"
                >
                  管理 MCP 分发 →（变更对新会话生效）
                </button>
              </li>
            </ul>
          </>
        )}
      </span>
    );
  }

  // 向标签条上报标题/运行状态；值没变就不惊动父组件
  const title = initialTitle ?? selectedProfile?.name ?? agentLabel(agentId);
  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  // 真实 cwd 跟随：进程存活期间每 4s 问一次后端 PTY 进程的真实 cwd——shell 内 cd 后
  // 文件树/git 面板也能跟上（此前只认启动栏路径，切标签「不跟随」的根源之一）。
  // 启动栏输入框聚焦时不覆盖，避免打断用户编辑
  const cwdInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!visible || !activePtyId || (!running && !shellActive)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const real = await invoke<string | null>("pty_get_cwd", {
          ptyId: activePtyId,
        });
        if (
          !cancelled &&
          real &&
          document.activeElement !== cwdInputRef.current
        ) {
          setCwd((cur) => (cur === real ? cur : real));
        }
      } catch {
        /* PTY 已退出 / 平台不支持（Windows 返回 null 走不到这）：静默 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, activePtyId, running, shellActive]);
  const [attention, setAttention] = useState<TabStatus["attention"]>(null);
  const lastReportRef = useRef("");
  useEffect(() => {
    const s: TabStatus = {
      title,
      alive: running || shellActive,
      running,
      shell: shellActive,
      agentId,
      profileId,
      model,
      cwd,
      ptyId: activePtyId,
      // 注意力标记只在 agent 运行中且已联动会话时有意义
      attention: running && !shellActive && sessionFile ? attention : null,
      canResume: shellActive && lastResumeRef.current != null,
      sessionId:
        linkCtxRef.current?.sessionId ??
        linkCtxRef.current?.hint ??
        lastResumeRef.current ??
        resumeSessionId ??
        null,
    };
    const key = JSON.stringify(s);
    if (key !== lastReportRef.current) {
      lastReportRef.current = key;
      onStatus(tabId, s);
    }
  }, [
    title,
    running,
    shellActive,
    agentId,
    profileId,
    model,
    cwd,
    activePtyId,
    attention,
    sessionFile,
    resumeSessionId,
    onStatus,
  ]);

  // 当前对话数据镜像给页面级右侧面板
  useEffect(() => {
    onSessionUpdate(tabId, {
      file: sessionFile,
      sessionId: linkedSessionId,
      title: linkedSessionTitle,
      agentId: linkState === "idle" ? null : agentId,
      state: linkState,
      conv,
    });
  }, [
    sessionFile,
    linkedSessionId,
    linkedSessionTitle,
    linkState,
    agentId,
    conv,
    onSessionUpdate,
  ]);

  // 从工作树带入目录创建的标签：聚焦配置选择，选好即可启动
  const profileSelectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (initialCwd) profileSelectRef.current?.focus();
  }, [initialCwd]);

  // 懒挂载：首次可见时才创建 xterm，未展示过的标签不占用终端资源
  const [everVisible, setEverVisible] = useState(visible);
  useEffect(() => {
    if (visible) setEverVisible(true);
  }, [visible]);

  useEffect(() => {
    if (!everVisible) return;
    const term = new Terminal({
      fontFamily: `'${settingsRef.current?.terminalFontFamily ?? "JetBrains Mono"}', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace`,
      fontSize: settingsRef.current?.terminalFontSize ?? 14,
      // 显示质感微调：清瘦锐利（向 Ghostty 靠）、盒绘对齐、粗体增亮、平滑滚动
      fontWeight: 400,
      fontWeightBold: 600,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      // Ink 类 TUI（Gemini CLI）整片高频重绘时，平滑滚动动画会叠加成闪烁——关闭
      smoothScrollDuration: 0,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: settingsRef.current?.scrollback ?? 5000,
      theme: buildXtermTheme(
        settingsRef.current?.theme ?? "midnight",
        settingsRef.current?.terminalPalette,
      ),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(containerRef.current!);
    try {
      fit.fit();
    } catch {
      // 容器隐藏时 fit 会算不出尺寸，可见时再 fit
    }
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Cmd/Ctrl+F 在终端聚焦时也呼出搜索条（拦在 xterm 之前，避免 Ctrl+F 字符进 PTY）
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "f"
      ) {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    // WebGL 加速失败、软件渲染（SwiftShader 等，闪烁）或上下文丢失时退回 xterm 默认渲染器。
    try {
      if (!isSoftwareWebGL()) {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
      }
    } catch {
      // GPU/驱动不支持时保持默认渲染器
    }

    const onWinResize = () => {
      try {
        fit.fit();
      } catch {}
    };
    window.addEventListener("resize", onWinResize);

    const subs = [
      term.onData((data) => {
        const id = ptyIdRef.current;
        if (id) invoke("pty_write", { ptyId: id, data }).catch(() => {});
      }),
      term.onResize(({ cols, rows }) => {
        const id = ptyIdRef.current;
        if (id) invoke("pty_resize", { ptyId: id, cols, rows }).catch(() => {});
      }),
    ];

    // 只在组件卸载（标签被关闭 / 应用退出）时清理 PTY；隐藏不触发
    return () => {
      window.removeEventListener("resize", onWinResize);
      subs.forEach((s) => s.dispose());
      stopLinkTimer();
      // 释放 liveSessions 登记（「进行中」标记随标签消失）
      const sid = linkCtxRef.current?.sessionId;
      const linkedAgent = linkCtxRef.current?.agentId;
      if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
      invoke("release_session_claim", { claimId: tabId }).catch(() => {});
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      ptyKindRef.current = null;
      if (id) invoke("pty_kill", { ptyId: id }).catch(() => {});
      unlistenRef.current.forEach((u) => u());
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everVisible]);

  // 标签从隐藏切回可见 / 右侧面板开关改变可用宽度时重新 fit（display:none 下尺寸为 0）
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
  }, [visible, rightOpen, layoutKey]);

  // 最近项目/⇄「真进入」：外部注入的 cwd 落地到启动栏；shell 存活时写 cd 让终端真正跟上
  //（否则树走了 shell 还在原地，真实 cwd 轮询会把路径拉回旧目录）
  useEffect(() => {
    if (visible && externalCwd && !running) {
      setCwd(externalCwd);
      if (shellActive && activePtyId) {
        invoke("pty_write", {
          ptyId: activePtyId,
          data: `cd ${shQuote(externalCwd)}\n`,
        }).catch(() => {});
      }
      onConsumeExternalCwd?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, externalCwd, running]);

  // 工作区合并/归档/删除后：本标签还留在被移除的工作树里时切回主仓库（shell 写 cd +
  // 启动栏更新），避免目录被删后终端/文件树烂尾
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const shellRef = useRef({ shellActive, running, activePtyId });
  shellRef.current = { shellActive, running, activePtyId };
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ worktreePath: string; repoPath: string }>("ws-archived", (e) => {
      const { worktreePath, repoPath } = e.payload;
      const cur = cwdRef.current;
      if (cur !== worktreePath && !cur.startsWith(`${worktreePath}/`)) return;
      setCwd(repoPath);
      const s = shellRef.current;
      if (s.shellActive && !s.running && s.activePtyId) {
        invoke("pty_write", {
          ptyId: s.activePtyId,
          data: `cd ${shQuote(repoPath)}\n`,
        }).catch(() => {});
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  // run 脚本标签：终端就绪后自动开 shell 并写入脚本命令（tty 会缓冲输入直到 shell 读取）。
  // 声明在终端创建 effect 之后，保证 attach 时 termRef 已就位
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!shellOnly || !visible || !everVisible || autoStartedRef.current)
      return;
    autoStartedRef.current = true;
    void (async () => {
      try {
        const ptyId = await invoke<string>("shell_spawn", {
          cwd,
          extraEnv: initialExtraEnv ?? null,
          purpose: "script",
        });
        await attach(ptyId, "shell", { reset: true });
        setExited(false);
        setShellActive(true);
        // 与「启动后自动收缩」一致：脚本已接管终端，启动栏收成一行
        setBarExpanded(false);
        if (prefillCommand) {
          await invoke("pty_write", { ptyId, data: `${prefillCommand}\n` });
        }
      } catch (e) {
        setError(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, shellOnly]);

  // 会话恢复标签：首次可见且找得到配置时自动启动一次（找不到则只预填，由用户处理）
  const autoLaunchedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || !visible || !everVisible || autoLaunchedRef.current)
      return;
    autoLaunchedRef.current = true;
    if (profiles.some((p) => p.id === profileId)) {
      void launch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, autoStart, profileId, profiles]);

  /** 把一个 PTY 接到 xterm 上；agent 退出时自动回落到 shell */
  async function attach(
    ptyId: string,
    kind: PtyKind,
    opts?: { reset?: boolean },
  ) {
    const term = termRef.current!;
    if (opts?.reset) term.reset();
    unlistenRef.current.forEach((u) => u());
    ptyIdRef.current = ptyId;
    ptyKindRef.current = kind;
    setActivePtyId(ptyId);
    unlistenRef.current = [
      await listen<string>(`pty-output-${ptyId}`, (e) => term.write(e.payload)),
      await listen<number>(`pty-exit-${ptyId}`, () => {
        void onPtyExit(ptyId);
      }),
    ];
    try {
      fitRef.current?.fit();
    } catch {}
    await invoke("pty_resize", {
      ptyId,
      cols: term.cols,
      rows: term.rows,
    }).catch(() => {});
    term.focus();
  }

  async function onPtyExit(exitedId: string) {
    // 已被 launch/cleanup 切换到新 PTY，忽略这个过期的退出事件
    if (ptyIdRef.current !== exitedId) return;
    const kind = ptyKindRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    setActivePtyId(null);
    setRunning(false);
    setAttention(null); // agent 退出：清除注意力标记
    if (kind === "agent") {
      // 记录可恢复的会话 id（一键恢复按钮用）
      lastResumeRef.current = linkCtxRef.current?.sessionId ?? null;
      // agent 退出（含手动停止）→ 同一终端自动回落到登录 shell
      termRef.current?.write(
        "\r\n\x1b[90m── agent 已结束（会话已保存，可一键恢复）── 当前为 shell ──\x1b[0m\r\n",
      );
      try {
        // 用 cwdRef 取最新目录：运行期间 pty_get_cwd 轮询更新的 cwd 不进本闭包
        const id = await invoke<string>("shell_spawn", {
          cwd: cwdRef.current,
          extraEnv: initialExtraEnv ?? null,
        });
        // 等待 shell_spawn 期间用户可能已重新启动：已有新 PTY 时杀掉这个回落 shell，不抢监听
        if (ptyIdRef.current !== null) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }
        await attach(id, "shell");
        setShellActive(true);
      } catch (e) {
        setError(String(e));
        setExited(true);
      }
      void finalizeLink();
    } else {
      setShellActive(false);
      setExited(true);
    }
  }

  /** 彻底清理当前 PTY（用于重新启动前/手动开 shell 前）；先置空引用以抑制自动回落 */
  async function cleanupPty() {
    const id = ptyIdRef.current;
    ptyIdRef.current = null;
    ptyKindRef.current = null;
    if (id) await invoke("pty_kill", { ptyId: id }).catch(() => {});
    unlistenRef.current.forEach((u) => u());
    unlistenRef.current = [];
    resetLink();
  }

  function stopLinkTimer() {
    if (linkTimerRef.current) {
      clearInterval(linkTimerRef.current);
      linkTimerRef.current = null;
    }
  }

  /** 找当前 agent 进程对应的会话文件：有 hint 精确匹配，否则走后端排他声明。 */
  async function findSessionFile(): Promise<{
    filePath: string;
    sessionId: string;
    title: string | null;
  } | null> {
    const ctx = linkCtxRef.current;
    if (!ctx) return null;
    try {
      if (ctx.hint) {
        const list = await invoke<SessionMetaDto[]>("list_sessions");
        const hit = list.find(
          (s) => s.agent === ctx.agentId && s.sessionId === ctx.hint,
        );
        return hit
          ? {
              filePath: hit.filePath,
              sessionId: ctx.hint,
              title: hit.customTitle || hit.title,
            }
          : null;
      }
      const meta = await invoke<SessionMetaDto | null>("claim_session_for", {
        claimId: tabId,
      });
      return meta
        ? {
            filePath: meta.filePath,
            sessionId: meta.sessionId,
            title: meta.customTitle || meta.title,
          }
        : null;
    } catch {
      return null;
    }
  }

  const convSigRef = useRef("");

  async function fetchConversation(force = false) {
    const ctx = linkCtxRef.current;
    if (!ctx?.filePath) return;
    let nextSig: string | null = null;
    // 签名门控：文件 mtime/size 没变就跳过本轮；变化时只读取最近的有界窗口。
    if (!force) {
      const sig = await invoke<[number, number] | null>("session_file_sig", {
        filePath: ctx.filePath,
      }).catch(() => null);
      if (sig && `${sig[0]}:${sig[1]}` === convSigRef.current) return;
      if (sig) nextSig = `${sig[0]}:${sig[1]}`;
    }
    try {
      const page = await invoke<ConversationPageDto>(
        "get_session_conversation_page",
        {
          agent: ctx.agentId,
          filePath: ctx.filePath,
          before: null,
        },
      );
      if (linkCtxRef.current !== ctx) return;
      setConv(page.messages.slice(-50));
      if (nextSig) convSigRef.current = nextSig;
      setLinkState("linked");
    } catch {
      // 会话文件可能写到一半，下轮再试
    }
    // P3c：同一路径顺带轮询会话尾部状态（done/working/confirm/unknown）
    try {
      const state = await invoke<string>("session_tail_state", {
        agent: ctx.agentId,
        filePath: ctx.filePath,
      });
      if (linkCtxRef.current !== ctx) return;
      setAttention(
        state === "done" || state === "working" || state === "confirm"
          ? state
          : null,
      );
    } catch {
      setAttention(null);
    }
  }

  /** 会话文件锁定：登记 liveSessions（会话页「进行中」+ 反向跳转） */
  function lockLink(filePath: string, sessionId: string, title: string | null) {
    const ctx = linkCtxRef.current;
    if (!ctx || ctx.filePath) return;
    ctx.filePath = filePath;
    ctx.sessionId = sessionId;
    setSessionFile(filePath);
    setLinkedSessionId(sessionId);
    setLinkedSessionTitle(title);
    setLinkState("linked");
    setLiveSession(ctx.agentId, sessionId, tabId);
  }

  async function linkTick() {
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (!hit) {
        if (Date.now() - linkStartedAtRef.current >= 20_000)
          setLinkState("timeout");
        return;
      }
      lockLink(hit.filePath, hit.sessionId, hit.title);
    }
    await fetchConversation();
  }

  function startLinkPolling() {
    stopLinkTimer();
    linkTimerRef.current = setInterval(() => void linkTick(), 3000);
    void linkTick();
  }

  /** agent 退出后停止轮询，最后再抓一次拿到完整对话 */
  async function finalizeLink() {
    stopLinkTimer();
    const ctx = linkCtxRef.current;
    if (!ctx) return;
    if (!ctx.filePath) {
      const hit = await findSessionFile();
      if (hit) lockLink(hit.filePath, hit.sessionId, hit.title);
      else setLinkState("timeout");
    }
    await fetchConversation(true);
    const sid = linkCtxRef.current?.sessionId;
    const linkedAgent = linkCtxRef.current?.agentId;
    if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
  }

  function resetLink() {
    stopLinkTimer();
    const sid = linkCtxRef.current?.sessionId;
    const linkedAgent = linkCtxRef.current?.agentId;
    if (sid && linkedAgent) setLiveSession(linkedAgent, sid, null);
    invoke("release_session_claim", { claimId: tabId }).catch(() => {});
    linkCtxRef.current = null;
    convSigRef.current = "";
    setSessionFile(null);
    setLinkedSessionId(null);
    setLinkedSessionTitle(null);
    setLinkState("idle");
    setConv([]);
    setAttention(null);
  }

  async function launch(resumeId?: string) {
    setError(null);
    await cleanupPty();
    setLinkState("detecting");
    linkStartedAtRef.current = Date.now();
    try {
      const res = await invoke<{
        ptyId: string;
        sessionHint: string | null;
        promptDropped: boolean;
      }>("pty_spawn", {
        agentId,
        profileId,
        cwd,
        model: model || null,
        // 工作区交接的附加 env（端口段），与 profile env 叠加
        extraEnv: initialExtraEnv ?? null,
        // 会话恢复（无则全新会话）
        resumeSessionId: resumeId ?? resumeSessionId ?? null,
        // 一键开步的首条指令（恢复会话由后端忽略注入）
        initialPrompt: promptText.trim() || null,
        linkClaimId: tabId,
      });
      localStorage.setItem(
        "ccode.lastLaunch",
        JSON.stringify({ agentId, profileId, model, cwd }),
      );
      // 模型历史（本 agent 维度，去重前置，上限 10 条）：模型 combo 下拉的可选项来源之一
      if (model.trim()) {
        try {
          const key = `ccode.modelHistory.${agentId}`;
          const list = JSON.parse(
            localStorage.getItem(key) ?? "[]",
          ) as string[];
          localStorage.setItem(
            key,
            JSON.stringify(
              [model.trim(), ...list.filter((m) => m !== model.trim())].slice(
                0,
                10,
              ),
            ),
          );
        } catch {
          /* 损坏则重置 */
        }
      }
      // 记住各 agent 上次使用的配置（会话恢复的兜底选择）
      localStorage.setItem(`ccode.lastProfile.${agentId}`, profileId);
      // 工作区记住上次配置（W3：worktree 目录下的启动）
      if (cwd.includes("/ccode/workspaces/")) {
        localStorage.setItem(
          `ccode.wsLast.${cwd}`,
          JSON.stringify({ agentId, profileId, model }),
        );
      }
      // SessionLink：记录启动上下文，开始轮询会话文件
      linkCtxRef.current = {
        agentId,
        cwd,
        hint: res.sessionHint,
        filePath: null,
        sessionId: null,
      };
      startLinkPolling();
      await attach(res.ptyId, "agent", { reset: true });
      setExited(false);
      setShellActive(false);
      setRunning(true);
      if (res.promptDropped) {
        // 该 CLI 无交互注入参数（kimi/opencode）：保留启动栏展开与指令文本，
        // 用户可复制后在终端里手动发送
        setError("该 CLI 不支持启动注入，请手动发送首条指令");
      } else {
        // 一次性：注入成功（或未携带指令）即清除，之后「启动」不再重复发送
        setPromptText("");
        setShowPrompt(false);
        setBarExpanded(false);
      }
      if (restored) onRestoreComplete?.(tabId);
      // 本次启动已接管会话：清掉标签级 resumeSessionId，之后「启动」不会再接回旧会话
      if (resumeSessionId) onConsumeResume?.(tabId);
    } catch (e) {
      invoke("release_session_claim", { claimId: tabId }).catch(() => {});
      stopLinkTimer();
      setLinkState("idle");
      // cleanupPty 已杀掉旧 PTY：失败不能留下指向死 PTY 的幻影 shell 状态
      setShellActive(false);
      setActivePtyId(null);
      setExited(true);
      setError(String(e));
    }
  }

  async function openShell() {
    setError(null);
    await cleanupPty();
    try {
      const ptyId = await invoke<string>("shell_spawn", {
        cwd,
        extraEnv: initialExtraEnv ?? null,
      });
      await attach(ptyId, "shell", { reset: true });
      setExited(false);
      setShellActive(true);
      setBarExpanded(false);
    } catch (e) {
      // 旧 PTY 已被 cleanupPty 杀掉：同样清掉幻影 shell 状态
      setShellActive(false);
      setActivePtyId(null);
      setExited(true);
      setError(String(e));
    }
  }

  /** 重启占位标签只在用户点击后恢复；目录失效时保留表单供修改，不盲目回落到其他目录。 */
  async function restoreTask() {
    if (!selectedProfile) {
      setError("上次使用的配置已不存在，请重新选择配置");
      setBarExpanded(true);
      return;
    }
    try {
      await invoke("list_dir", { path: cwd, showHidden: false });
    } catch {
      setError("上次工作目录不存在或不可读，请修改目录后再恢复");
      setBarExpanded(true);
      return;
    }
    await launch();
  }

  /** 停止 agent：杀掉 PTY 后由退出事件自动回落到 shell */
  async function stop() {
    const id = ptyIdRef.current;
    if (id) await invoke("pty_kill", { ptyId: id }).catch(() => {});
  }

  function openConversationPage() {
    const sessionId = linkCtxRef.current?.sessionId ?? lastResumeRef.current;
    if (!sessionId) return;
    setOpenSessionReq({
      agent: linkCtxRef.current?.agentId ?? agentId,
      sessionId,
    });
    setPage("sessions");
  }

  // 标签条 ⋯ 菜单动作表：actionsRef 每次渲染更新为最新闭包；挂载时只注册一次稳定转发对象，
  // 父级 ⋯ 菜单调用时穿透 ref，不会拿到首次渲染的陈旧 agent/profile/model/cwd
  const actionsRef = useRef<FocusTabActions>({
    stop: () => {},
    resume: () => {},
    openConversationPage: () => {},
    search: () => {},
    modify: () => {},
  });
  actionsRef.current = {
    stop: () => void stop(),
    resume: () => {
      if (lastResumeRef.current)
        void launch(lastResumeRef.current ?? undefined);
    },
    openConversationPage,
    search: () => setSearchOpen(true),
    modify: () => setBarExpanded(true),
  };
  useEffect(() => {
    onActions?.(tabId, {
      stop: () => actionsRef.current.stop(),
      resume: () => actionsRef.current.resume(),
      openConversationPage: () =>
        actionsRef.current.openConversationPage(),
      search: () => actionsRef.current.search(),
      modify: () => actionsRef.current.modify(),
    });
  }, [onActions, tabId]);

  // P1b：启动栏输入框统一 inset 底（浮起层级），聚焦边线不变
  const select =
    "h-8 rounded-md border border-field bg-inset px-2 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";

  function openTerminalActionMenu(event: React.MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setTerminalActionMenu({ x: rect.right - 176, y: rect.bottom + 4 });
  }

  const terminalMenuItems = [
    ...(running
      ? [{ label: "停止（回落 Shell）", onSelect: () => void stop() }]
      : []),
    ...(lastResumeRef.current && shellActive
      ? [
          {
            label: "⟳ 恢复对话",
            onSelect: () => void launch(lastResumeRef.current ?? undefined),
          },
        ]
      : []),
    ...(sessionFile || lastResumeRef.current
      ? [{ label: "⤴ 在对话页打开", onSelect: openConversationPage }]
      : []),
    ...(sessionFile && linkedSessionId
      ? [
          {
            label: "◈ 接力到…",
            onSelect: () =>
              onHandoff?.({
                agent: linkCtxRef.current?.agentId ?? agentId,
                sessionId: linkedSessionId,
                filePath: sessionFile,
                cwd,
                title: linkedSessionTitle,
              }),
          },
        ]
      : []),
    ...(!running && !shellActive
      ? [{ label: "打开 Shell", onSelect: () => void openShell() }]
      : []),
    { label: "◎ 查找终端输出", onSelect: () => setSearchOpen(true) },
  ];

  return (
    <div className="flex h-full flex-col px-2 pt-1">
      {barExpanded ? (
        <>
          <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
            <select
              className={`${select} w-36 shrink-0`}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setProfileId("");
                setModel("");
              }}
              disabled={running}
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <select
              ref={profileSelectRef}
              className={`${select} w-40 shrink-0`}
              value={profileId}
              onChange={(e) => {
                setProfileId(e.target.value);
                const prof = profiles.find((p) => p.id === e.target.value);
                setModel(prof?.models[0] ?? "");
              }}
              disabled={running}
            >
              <option value="" disabled>
                选择配置
              </option>
              {profileId && !selectedProfile && (
                <option value={profileId}>上次配置已不存在</option>
              )}
              {agentProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {selectedProfile && (
              // 模型 combo-box：可输可选（profile 预设 + 本 agent 历史），输入即筛选，
              // 自由输入的模型启动成功后记入历史（ccode.modelHistory.<agent>），下次直接可选
              <span className="relative w-44 shrink-0">
                <input
                  className={`${select} w-full`}
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setModelOpen(true);
                  }}
                  onFocus={() => setModelOpen(true)}
                  onBlur={() => setModelOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || e.key === "Enter")
                      setModelOpen(false);
                  }}
                  placeholder="模型（可选可输）"
                  disabled={running}
                  title="选择或输入本次启动使用的模型"
                />
                {modelOpen && modelOptions.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border border-field bg-raised py-1">
                    {modelOptions
                      .filter((m) =>
                        m.toLowerCase().includes(model.trim().toLowerCase()),
                      )
                      .map((m) => (
                        <li key={m}>
                          <button
                            type="button"
                            // mousedown 抢在 input blur 前生效，选项才不会一闪而过
                            onMouseDown={(e) => {
                              e.preventDefault();
                              setModel(m);
                              setModelOpen(false);
                            }}
                            className="flex w-full truncate px-2 py-1 text-left text-xs text-l2 hover:bg-white/5 hover:text-l1"
                          >
                            {m}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </span>
            )}
            <input
              ref={cwdInputRef}
              className={`${select} min-w-40 flex-1`}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="工作目录，如 ~/work/myproject"
              disabled={running}
            />
            {/* run 脚本（shellOnly）标签不走 agent 启动流程：隐藏启动/停止按钮，
                避免误点「启动」无确认杀掉正在跑的脚本 shell */}
            {!shellOnly &&
              (running ? (
                <button
                  onClick={stop}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-field bg-inset px-3 text-sm text-err-text hover:bg-white/5"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={() => (restored ? void restoreTask() : void launch())}
                  disabled={!profileId}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-cta-bd bg-cta px-3 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
                >
                  {restored ? "恢复任务" : "启动"}
                </button>
              ))}
          </div>
          {/* 一键开步的首条指令：可编辑，留空 = 不注入；注入成功即清除 */}
          {showPrompt && !shellOnly && (
            <div className="mb-2 flex items-center gap-2">
              <span className="shrink-0 text-xs text-l3">启动后自动发送：</span>
              <input
                className={`${select} min-w-0 flex-1 py-1 text-xs`}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder="留空则不注入首条指令"
                disabled={running}
              />
            </div>
          )}
          <div className="mb-2 flex min-h-7 flex-wrap items-center gap-2 border-t border-hairline pt-1 text-xs">
            {renderSkillMenu(true)}
            {renderMcpMenu(true)}
            {initialExtraEnv && Object.keys(initialExtraEnv).length > 0 && (
              <span
                className="rounded bg-inset px-1.5 py-0.5 text-l3"
                title={`启动时注入：\n${Object.entries(initialExtraEnv)
                  .map(([k, v]) => `${k}=${v}`)
                  .join("\n")}`}
              >
                工作区 · 端口段已注入
              </span>
            )}
            {shellActive && !running && (
              <span className="text-l3">shell 模式</span>
            )}
            {exited && !running && !shellActive && (
              <span className="text-l3">进程已退出</span>
            )}
            {restored && !running && !shellActive && (
              <span className="text-link">上次任务，可恢复</span>
            )}
            {error && <span className="truncate text-err-text">{error}</span>}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={openTerminalActionMenu}
                title="更多终端操作"
                aria-label="更多终端操作"
                className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
              >
                ⋯
              </button>
            </span>
          </div>
          {agentProfiles.length === 0 && (
            <p className="mb-2 text-sm text-l3">
              该 agent 暂无配置，请先在「配置」页创建。
            </p>
          )}
          {autoStart &&
            profileId &&
            !profiles.some((p) => p.id === profileId) && (
              <p className="mb-2 text-sm text-l3">请先为该 agent 创建配置</p>
            )}
        </>
      ) : focusMode ? null : (
        /* 收缩态只保留启动配置入口；对话统一从右侧工作台进入。 */
        <div className="mb-1 flex h-7 items-center gap-2 text-xs text-l4">
          <span className="truncate">
            {agentLabel(agentId)}
            {selectedProfile ? ` · ${selectedProfile.name}` : ""}
            {model ? ` · ${model}` : ""}
            {` · ${basename(cwd)}`}
            {gitTotals && (gitTotals.add > 0 || gitTotals.del > 0) && (
              <span
                className="ml-1 font-mono"
                title="变更（git diff vs HEAD / 任务累计）"
              >
                <span className="text-add">+{gitTotals.add}</span>
                <span className="text-del">-{gitTotals.del}</span>
              </span>
            )}
            {shellActive && !running ? " · shell 模式" : ""}
            {exited && !running && !shellActive ? " · 已退出" : ""}
          </span>
          {error && <span className="truncate text-err-text">{error}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* 技能/MCP 入口在收缩态（运行中）同样可用——展开栏收起后不能丢入口 */}
            {renderSkillMenu(false)}
            {renderMcpMenu(false)}
            <button
              type="button"
              onClick={() => setBarExpanded(true)}
              title="修改启动配置"
              className="rounded px-2 py-1 text-l3 hover:bg-white/5 hover:text-l1"
            >
              修改
            </button>
            <button
              type="button"
              onClick={openTerminalActionMenu}
              title="更多终端操作"
              aria-label="更多终端操作"
              className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
            >
              ⋯
            </button>
          </span>
        </div>
      )}
      {/* 输出搜索条：Cmd/Ctrl+F 或「查找」按钮呼出；只作用于本标签的 xterm */}
      {searchOpen && (
        <div className="mb-1 flex items-center gap-1 rounded-md bg-strip px-2 py-1">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) findPrev();
                else findNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
            placeholder="查找终端输出"
            className="w-56 rounded border border-field bg-inset px-2 py-1 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
          />
          <button
            onClick={findPrev}
            title="上一个（Shift+Enter）"
            className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
          >
            ↑
          </button>
          <button
            onClick={() => findNext()}
            title="下一个（Enter）"
            className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            title="关闭（Esc）"
            className="flex h-7 w-7 items-center justify-center rounded text-sm text-l3 hover:bg-white/5 hover:text-l1"
          >
            ×
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          className="min-w-0 flex-1 overflow-hidden px-3 py-2.5"
        />
      </div>
      {terminalActionMenu && (
        <ContextMenu
          x={terminalActionMenu.x}
          y={terminalActionMenu.y}
          onClose={() => setTerminalActionMenu(null)}
          items={terminalMenuItems}
        />
      )}
    </div>
  );
});

interface Tab {
  id: string;
  /** 兜底空标签：不继承「上次启动」记录（关闭最后标签时使用） */
  skipSeed?: boolean;
  /** 从工作树「在此打开」/ 工作区创建时预填的启动目录 */
  initialCwd?: string;
  /** 工作区交接的附加 env（端口段） */
  initialExtraEnv?: Record<string, string>;
  /** 工作区交接的标签标题（工作区名 / run: 脚本名） */
  initialTitle?: string;
  /** 预填启动栏（会话恢复 / 工作区记住配置） */
  initialAgentId?: string;
  initialProfileId?: string;
  initialModel?: string;
  /** 会话恢复：pty_spawn 的 resumeSessionId */
  resumeSessionId?: string;
  /** 首次可见自动启动（会话恢复） */
  autoStart?: boolean;
  /** run 脚本：进入 shell 后立即写入的命令行 */
  prefillCommand?: string;
  /** run 脚本标签：自动开 shell 执行 prefillCommand */
  shellOnly?: boolean;
  /** 一键开步预填的首条指令（启动时注入，一次性；不进重启持久化白名单） */
  initialPrompt?: string;
  /** 应用重启后恢复出的元数据占位标签。 */
  restored?: boolean;
}

export default function TerminalPage({ visible }: { visible: boolean }) {
  const setOpenSessionReq = useAppStore((s) => s.setOpenSessionReq);
  const setPage = useAppStore((s) => s.setPage);
  const [initialState] = useState(() => {
    const saved = parseRecoverableTerminalState(
      localStorage.getItem(TERMINAL_TABS_STORAGE_KEY),
    );
    if (saved.tabs.length === 0) {
      const tab: Tab = { id: crypto.randomUUID() };
      return { tabs: [tab], activeId: tab.id };
    }
    const restoredTabs: Tab[] = saved.tabs.map((tab) => ({
      id: crypto.randomUUID(),
      initialCwd: tab.cwd,
      initialTitle: tab.label,
      initialAgentId: tab.agentId,
      initialProfileId: tab.profileId,
      initialModel: tab.model,
      resumeSessionId: tab.sessionId ?? undefined,
      restored: true,
    }));
    return {
      tabs: restoredTabs,
      activeId: restoredTabs[saved.activeIndex]?.id ?? restoredTabs[0].id,
    };
  });
  const [tabs, setTabs] = useState<Tab[]>(initialState.tabs);
  const [activeId, setActiveId] = useState(initialState.activeId);
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  // 关闭守卫（关标签/关窗）在异步链路里取最新状态，避免闭包过期
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  // 分屏：splitTabId 非空即开启——左 pane 固定活跃标签，右 pane 为下拉选择的对照标签。
  // 状态只在内存（重启不恢复分屏），仅分隔比例像右栏宽度一样本地记忆。
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  /** 活跃 pane：右栏（对话/文件/改动）与文件树跟随它，点击 pane 切换 */
  const [activePane, setActivePane] = useState<"left" | "right">("left");
  const [splitPct, setSplitPct] = useState(() => {
    const saved = Number(localStorage.getItem(SPLIT_PCT_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSplitPct(saved) : 50;
  });
  // 各标签的当前对话数据（TerminalView 轮询后镜像上来）
  const [sessionByTab, setSessionByTab] = useState<
    Record<string, SessionLinkState>
  >({});
  // 左栏（工作树）：只有显示 /（被专注终端或专注内容）隐藏两种状态
  const [showHidden, setShowHidden] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /** 最近项目「真进入」：待注入活动标签启动栏的目录 */
  const [enterCwd, setEnterCwd] = useState<string | null>(null);
  // 「已完成」已读集合（P5 聚合视图）：点击跳过的标签不再计入「要你管」，仅本次会话内有效
  const seenDoneRef = useRef(new Set<string>());
  // 右侧成果工作台默认可见；对话、文件、改动在同一处切换，避免入口散落在终端标签内。
  const [rightOpen, setRightOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    const width =
      Number.isFinite(saved) && saved > 0 ? saved : RIGHT_PANEL_DEFAULT_WIDTH;
    return Math.min(
      RIGHT_PANEL_MAX_WIDTH,
      Math.max(RIGHT_PANEL_MIN_WIDTH, width),
    );
  });
  const [rightExpanded, setRightExpanded] = useState(false);
  const terminalRootRef = useRef<HTMLDivElement>(null);
  const normalRightWidthRef = useRef(rightWidth);
  // 专注终端：隐藏左栏与右面板，中带只剩全宽终端 + 顶部标签条（页级开关，默认关，Esc 退出）
  const [focusMode, setFocusMode] = useState(false);
  // 标签条 ⋯ 菜单：各标签动作表（TerminalView 挂载时注册）与菜单坐标
  const tabActionsRef = useRef(new Map<string, FocusTabActions>());
  const registerActions = useCallback((id: string, a: FocusTabActions) => {
    tabActionsRef.current.set(id, a);
  }, []);
  const [focusMenu, setFocusMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 「◈ 接力到…」目标选择器：从当前标签的会话生成简报并预填新终端
  const [handoffSource, setHandoffSource] = useState<HandoffSource | null>(
    null,
  );

  /** 标签条 ⋯ 菜单项（专注终端时替代标签内状态条）：按活动标签状态裁剪（不可用的动作不出现） */
  function focusMenuItems() {
    const s = statuses[focusedId];
    const acts = tabActionsRef.current.get(focusedId);
    const sessFile = sessionByTab[focusedId]?.file;
    const sessId = sessionByTab[focusedId]?.sessionId;
    const sessAgent = sessionByTab[focusedId]?.agentId;
    return [
      ...(s?.running
        ? [{ label: "停止（回落 shell）", onSelect: () => acts?.stop() }]
        : []),
      ...(s?.canResume
        ? [{ label: "⟳ 恢复会话", onSelect: () => acts?.resume() }]
        : []),
      ...(sessFile && sessId && sessAgent
        ? [
            {
              label: "◈ 接力到…",
              onSelect: () =>
                setHandoffSource({
                  agent: sessAgent,
                  sessionId: sessId,
                  filePath: sessFile,
                  cwd: statuses[focusedId]?.cwd ?? "~",
                  title: sessionByTab[focusedId]?.title ?? null,
                }),
            },
          ]
        : []),
      ...(sessFile || s?.canResume
        ? [
            {
              label: "⤴ 在对话页打开",
              onSelect: () => acts?.openConversationPage(),
            },
          ]
        : []),
      ...(s?.running || sessFile
        ? [
            {
              label: "对话面板",
              onSelect: () => {
                setFocusMode(false); // 右面板在专注终端下隐藏，先退出
                openSessionPanel();
              },
            },
          ]
        : []),
      { label: "◎ 查找终端输出", onSelect: () => acts?.search() },
      { label: "修改启动配置", onSelect: () => acts?.modify() },
      { label: "⤢ 退出专注终端", onSelect: () => setFocusMode(false) },
    ];
  }
  const [rightTab, setRightTab] = useState<RightTab>("dialogue");
  const [gitTotals, setGitTotals] = useState<{
    add: number;
    del: number;
  } | null>(null);
  // 中带「可合并」状态 pill（P1b 参考图 2）：当前项目可合并工作区名列表，空 = 不显示
  const [mergeReadyWs, setMergeReadyWs] = useState<string[]>([]);
  // pill 刷新信号：工作区归档事件（合并保留工作区的场景走 reviewPath 关闭触发刷新）
  const [wsPillTick, setWsPillTick] = useState(0);
  const [preview, setPreview] = useState<{
    path: string;
    name: string;
    root: string | null;
  } | null>(null);
  /** 预览编辑器脏状态（预览页签的脏点） */
  const [previewDirty, setPreviewDirty] = useState(false);
  /** 文件系统变化信号：FileTree 的 fs-changed 事件触发 GitPanel 一并刷新 */
  const [fsChangeTick, setFsChangeTick] = useState(0);
  /** 全宽任务审阅覆盖层；底下所有 TerminalView 继续挂载。 */
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<
    "pr" | "archive" | "resolve-conflict" | null
  >(null);
  const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
  const sessionScrollRef = useRef<HTMLDivElement>(null);
  const dialogueFollowRef = useRef(true);
  const [dialogueHasNew, setDialogueHasNew] = useState(false);

  // 分屏开启时右栏/文件树/改动跟随「活跃 pane」（点击 pane 或点标签条切换），否则跟随活跃标签
  const splitActive =
    splitTabId != null &&
    splitTabId !== activeId &&
    tabs.some((t) => t.id === splitTabId);
  const focusedId =
    splitActive && activePane === "right" && splitTabId ? splitTabId : activeId;
  const activeCwd = statuses[focusedId]?.cwd ?? "~";

  /** 标签激活：分屏时点到右 pane 的标签则左右互换（活跃标签始终固定在左 pane）；
      「已完成」点击跳过即视为已读（seenDoneRef，标签条注意力点同源） */
  function activateTab(id: string) {
    if (splitActive && id === splitTabId) setSplitTabId(activeId);
    if (statuses[id]?.attention === "done") seenDoneRef.current.add(id);
    setActiveId(id);
    setActivePane("left");
  }

  /** 分屏开关：开启时右 pane 默认选第一个非活跃标签；不足两个标签不可用 */
  function toggleSplit() {
    if (splitActive) {
      setSplitTabId(null);
      setActivePane("left");
      return;
    }
    const candidate = tabs.find((t) => t.id !== activeId);
    if (!candidate) return;
    setSplitTabId(candidate.id);
    setActivePane("left");
  }

  /** 关闭分屏一侧 pane：关右 = 退出分屏保留当前标签；关左 = 退出分屏并把对照标签转为活跃。
      不走 activateTab：退出分屏与换活跃同事务，activateTab 的左右互换分支会误把 splitTabId 写回 */
  function closePane(side: "left" | "right") {
    const keepId = side === "left" ? splitTabId : null;
    setSplitTabId(null);
    setActivePane("left");
    if (keepId) {
      if (statuses[keepId]?.attention === "done") seenDoneRef.current.add(keepId);
      setActiveId(keepId);
    }
  }

  /** 分屏分隔条拖拽（沿用右栏拖拽的记忆宽度模式；双击恢复对半） */
  const splitAreaRef = useRef<HTMLDivElement>(null);
  function startSplitResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = splitAreaRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const pctOf = (clientX: number) =>
      clampSplitPct(((clientX - rect.left) / rect.width) * 100);
    const onMove = (moveEvent: PointerEvent) => {
      setSplitPct(pctOf(moveEvent.clientX));
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalPct = pctOf(upEvent.clientX);
      setSplitPct(finalPct);
      localStorage.setItem(SPLIT_PCT_KEY, String(Math.round(finalPct)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function maxRightWidth(expanded = rightExpanded): number {
    const total = terminalRootRef.current?.clientWidth ?? window.innerWidth;
    const railWidth = expanded ? 0 : 240;
    return Math.max(
      RIGHT_PANEL_MIN_WIDTH,
      Math.min(RIGHT_PANEL_MAX_WIDTH, total - railWidth - 340),
    );
  }

  function clampRightWidth(width: number, expanded = rightExpanded): number {
    return Math.min(
      maxRightWidth(expanded),
      Math.max(RIGHT_PANEL_MIN_WIDTH, width),
    );
  }

  function toggleRightExpanded() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current, false));
      return;
    }
    normalRightWidthRef.current = rightWidth;
    const total = terminalRootRef.current?.clientWidth ?? window.innerWidth;
    setRightExpanded(true);
    setRightWidth(clampRightWidth(Math.round(total * 0.58), true));
  }

  function closeRightPanel() {
    if (rightExpanded) {
      setRightExpanded(false);
      setRightWidth(clampRightWidth(normalRightWidthRef.current, false));
    }
    setRightOpen(false);
  }

  function startRightResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightWidth;
    const expanded = rightExpanded;
    const onMove = (moveEvent: PointerEvent) => {
      setRightWidth(
        clampRightWidth(startWidth + startX - moveEvent.clientX, expanded),
      );
    };
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const finalWidth = clampRightWidth(
        startWidth + startX - upEvent.clientX,
        expanded,
      );
      setRightWidth(finalWidth);
      if (!expanded) {
        normalRightWidthRef.current = finalWidth;
        localStorage.setItem(
          RIGHT_PANEL_WIDTH_KEY,
          String(Math.round(finalWidth)),
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  useEffect(() => {
    const onResize = () => setRightWidth((width) => clampRightWidth(width));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightExpanded]);

  // Esc 退出专注：仅在专注终端/专注内容激活时才挂监听并拦截，
  // 平时完全不碰 Esc，避免与终端内的 Esc 输入（如 vim）冲突
  useEffect(() => {
    if (!focusMode && !rightExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (focusMode) setFocusMode(false);
      if (rightExpanded) toggleRightExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode, rightExpanded]);

  /** TerminalView 上报状态；内容没变就返回原对象，避免无谓重渲染 */
  const reportStatus = useCallback((id: string, s: TabStatus) => {
    setStatuses((prev) => {
      const cur = prev[id];
      if (cur && JSON.stringify(cur) === JSON.stringify(s)) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** TerminalView 镜像当前对话数据；引用没变就不更新 */
  const reportSession = useCallback((id: string, s: SessionLinkState) => {
    setSessionByTab((prev) => {
      const cur = prev[id];
      if (
        cur &&
        cur.file === s.file &&
        cur.sessionId === s.sessionId &&
        cur.title === s.title &&
        cur.agentId === s.agentId &&
        cur.state === s.state &&
        cur.conv === s.conv
      ) {
        return prev;
      }
      return { ...prev, [id]: s };
    });
  }, []);

  /** 成功拉起新 PTY 后，占位标签转为普通运行标签。 */
  const finishRestore = useCallback((id: string) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, restored: false } : tab)),
    );
  }, []);

  /** launch 已消费 resumeSessionId：从标签清掉，避免之后「启动」又接回旧会话 */
  const clearResumeSession = useCallback((id: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id && tab.resumeSessionId
          ? { ...tab, resumeSessionId: undefined }
          : tab,
      ),
    );
  }, []);

  // 只持久化可重新启动所需的白名单元数据；PTY、环境变量与脚本命令都不进入 localStorage。
  useEffect(() => {
    const snapshots = tabs.flatMap((tab) => {
      if (tab.shellOnly || tab.prefillCommand) return [];
      const status = statuses[tab.id];
      const profileId = status?.profileId ?? tab.initialProfileId ?? "";
      const sessionId = status?.sessionId ?? tab.resumeSessionId ?? null;
      const representsTask = tab.restored || status?.alive || !!sessionId;
      if (!representsTask || (!profileId && !sessionId)) return [];
      return [
        {
          tabId: tab.id,
          value: {
            label:
              status?.title ??
              tab.initialTitle ??
              agentLabel(
                status?.agentId ?? tab.initialAgentId ?? "claude-code",
              ),
            cwd: status?.cwd ?? tab.initialCwd ?? "~",
            agentId: status?.agentId ?? tab.initialAgentId ?? "claude-code",
            profileId,
            model: status?.model ?? tab.initialModel ?? "",
            sessionId,
          },
        },
      ];
    });
    if (snapshots.length === 0) {
      localStorage.removeItem(TERMINAL_TABS_STORAGE_KEY);
      return;
    }
    const activeIndex = Math.max(
      0,
      snapshots.findIndex((item) => item.tabId === activeId),
    );
    localStorage.setItem(
      TERMINAL_TABS_STORAGE_KEY,
      serializeRecoverableTerminalState({
        tabs: snapshots.map((item) => item.value),
        activeIndex,
      }),
    );
  }, [activeId, statuses, tabs]);

  /** GitPanel 上报改动总量（改动页签的 +N 徽标）；没变就不更新 */
  const reportGitTotals = useCallback((t: { add: number; del: number }) => {
    setGitTotals((prev) =>
      prev && prev.add === t.add && prev.del === t.del ? prev : t,
    );
  }, []);

  /** FileTree 的 fs-changed 事件 → GitPanel 一并刷新（稳定回调） */
  const bumpFsChangeTick = useCallback(() => setFsChangeTick((t) => t + 1), []);

  /** 工作树单击文件 → 右侧「预览」页签（编辑器自行加载内容；路径限制在后端校验） */
  const openPreview = useCallback(
    (path: string, name: string, root?: string) => {
      setRightOpen(true);
      setRightTab("preview");
      setPreview({ path, name, root: root ?? null });
      setPreviewDirty(false);
    },
    [],
  );

  /** 写入当前活跃终端标签 agent 输入的公共链路（pty_write；send=true 时末尾补 \r 直接发送，
      缺省不自动回车、用户检查后发送）。PDF 问 AI 与 md 讨论/改写共用；返回 null 表示已写入，返回字符串为预览区要展示的提示。 */
  const injectToActiveAgent = useCallback(
    (data: string, send?: boolean): string | null => {
      const s = statuses[focusedId];
      if (!s?.running || !s.ptyId) {
        return "当前标签没有运行中的 Agent，请先启动再试";
      }
      invoke("pty_write", {
        ptyId: s.ptyId,
        data: send ? `${data}\r` : data,
      }).catch(() => {});
      return null;
    },
    [statuses, focusedId],
  );

  /** PDF 选段「◈ 问 AI」：选段 + 出处格式化后注入活跃终端 */
  const askAiFromPdf = useCallback(
    (text: string, page: number, fileName: string, send?: boolean): string | null => {
      // 注入上限保护：选段过长时截断正文，避免把整页灌进输入框
      const body = text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
      const brief = text.replace(/\s+/g, " ").slice(0, 60);
      const data = `> 「${brief}${text.length > 60 ? "…" : ""}」（${fileName}，第 ${page} 页）\n\n${body}`;
      return injectToActiveAgent(data, send);
    },
    [injectToActiveAgent],
  );

  /** md 阅读视图选段「◈ 讨论/改写此段」：引用块格式注入，末尾引导行让用户接着补指令 */
  const discussMdExcerpt = useCallback(
    (text: string, fileName: string, send?: boolean): string | null => {
      // 注入上限保护：选段超过 4000 字截断
      const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      const quoted = body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
      const data = `> 引自《${fileName}》的选段：\n>\n${quoted}\n\n（在这里输入你的意见：讨论、提问或要求改写）`;
      return injectToActiveAgent(data, send);
    },
    [injectToActiveAgent],
  );

  /** 切换文件树根时关闭旧预览；脏文件先确认（异步内联确认框），且绝不映射新根下的同名文件。 */
  const closePreviewForRootChange = useCallback(async () => {
    if (!preview) return true;
    if (
      previewDirty &&
      !(await confirmDialog(
        "当前预览文件有未保存改动。切换文件树根目录将放弃这些改动，继续？",
        { danger: true },
      ))
    ) {
      return false;
    }
    setPreview(null);
    setPreviewDirty(false);
    return true;
  }, [preview, previewDirty]);

  /** 全部子组件共享的稳定回调（memo 不被行内箭头击穿） */
  const openSessionPanel = useCallback(() => {
    setRightTab("dialogue");
    setRightOpen(true);
  }, []);
  const consumeExternalCwd = useCallback(() => setEnterCwd(null), []);

  function scrollDialogueToBottom() {
    const el = sessionScrollRef.current;
    if (!el) return;
    dialogueFollowRef.current = true;
    setDialogueHasNew(false);
    el.scrollTop = el.scrollHeight;
  }

  function onDialogueScroll() {
    const el = sessionScrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
    dialogueFollowRef.current = nearBottom;
    if (nearBottom) setDialogueHasNew(false);
  }

  const activeSession = sessionByTab[focusedId];
  useEffect(() => {
    if (!rightOpen || rightTab !== "dialogue") return;
    dialogueFollowRef.current = true;
    setDialogueHasNew(false);
    requestAnimationFrame(scrollDialogueToBottom);
  }, [rightTab, rightOpen, focusedId]);
  useEffect(() => {
    if (!rightOpen || rightTab !== "dialogue") return;
    if (dialogueFollowRef.current)
      requestAnimationFrame(scrollDialogueToBottom);
    else setDialogueHasNew(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.conv]);

  const addTab = useCallback(
    (init?: {
      cwd?: string;
      extraEnv?: Record<string, string>;
      title?: string;
      agentId?: string;
      profileId?: string;
      model?: string;
      resumeSessionId?: string;
      autoStart?: boolean;
      prefillCommand?: string;
      shellOnly?: boolean;
      initialPrompt?: string;
    }): string => {
      const t: Tab = {
        id: crypto.randomUUID(),
        initialCwd: init?.cwd,
        initialExtraEnv: init?.extraEnv,
        initialTitle: init?.title,
        initialAgentId: init?.agentId,
        initialProfileId: init?.profileId,
        initialModel: init?.model,
        resumeSessionId: init?.resumeSessionId,
        autoStart: init?.autoStart,
        prefillCommand: init?.prefillCommand,
        shellOnly: init?.shellOnly,
        initialPrompt: init?.initialPrompt,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
      return t.id;
    },
    [],
  );

  /** 工作树「在此打开新终端」：新建标签并预填 cwd，用户选 agent/profile 后启动 */
  const openTerminalAt = useCallback(
    (path: string) => {
      addTab({ cwd: path });
    },
    [addTab],
  );

  // 消费工作区页/会话页交来的终端启动请求（可见时才消费，保证标签能立刻聚焦启动栏）
  const pendingTerminal = useAppStore((s) => s.pendingTerminal);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const workspaceReviewRequest = useAppStore((s) => s.workspaceReviewRequest);
  const setWorkspaceReviewRequest = useAppStore(
    (s) => s.setWorkspaceReviewRequest,
  );
  const setRunningScript = useAppStore((s) => s.setRunningScript);
  // closeTab 里取最新互斥登记表（避免闭包过期）
  const runningScripts = useAppStore((s) => s.runningScripts);
  const runningScriptsRef = useRef(runningScripts);
  runningScriptsRef.current = runningScripts;
  const profiles = useAppStore((s) => s.profiles);
  useEffect(() => {
    if (visible && pendingTerminal) {
      setPendingTerminal(null);
      // 显式打开另一任务的终端时，不让上一次任务审阅继续盖住新标签。
      setReviewPath(null);
      const pt = pendingTerminal;
      // 会话恢复：profile 依次 autoLaunchProfileId → ccode.lastProfile → 该 agent 首个配置
      const agentId = pt.agentId ?? pt.resume?.agentId;
      let profileId = pt.profileId;
      let model = pt.model;
      if (pt.resume) {
        profileId =
          pt.autoLaunchProfileId ??
          localStorage.getItem(`ccode.lastProfile.${pt.resume.agentId}`) ??
          profiles.find((p) => p.agent === pt.resume!.agentId)?.id ??
          "";
        model = profiles.find((p) => p.id === profileId)?.models[0] ?? "";
      }
      const tabId = addTab({
        cwd: pt.cwd,
        extraEnv: pt.extraEnv,
        title: pt.title,
        agentId,
        profileId,
        model,
        resumeSessionId: pt.resume?.sessionId,
        autoStart: !!pt.resume,
        prefillCommand: pt.prefillCommand,
        shellOnly: pt.shellOnly,
        initialPrompt: pt.initialPrompt,
      });
      // run 脚本标签：登记 nonconcurrent 互斥追踪
      if (pt.wsId) setRunningScript(pt.wsId, tabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pendingTerminal, setPendingTerminal, setRunningScript]);

  // 工作区页交来的评审请求：只打开覆盖层，不新建/切换/卸载终端标签。
  useEffect(() => {
    if (!visible || !workspaceReviewRequest) return;
    setReviewPath(workspaceReviewRequest.worktreePath);
    setReviewAction(workspaceReviewRequest.action ?? null);
    setReviewRequestId(workspaceReviewRequest.requestId);
    setFocusMode(false);
    setWorkspaceReviewRequest(null);
  }, [visible, workspaceReviewRequest, setWorkspaceReviewRequest]);

  // 首页「待你处理」交来的标签激活请求：跳到终端页并激活该标签（已关闭的标签静默忽略）
  const focusTabReq = useAppStore((s) => s.focusTabReq);
  const setFocusTabReq = useAppStore((s) => s.setFocusTabReq);
  useEffect(() => {
    if (!visible || !focusTabReq) return;
    if (tabs.some((t) => t.id === focusTabReq)) activateTab(focusTabReq);
    setFocusTabReq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, focusTabReq, tabs, setFocusTabReq]);

  // 资源面板「查看」交来的预览请求：绝对路径（未必在任何文件树根内），
  // root 留空——PDF 走后端白名单校验，不需要预览根
  const previewReq = useAppStore((s) => s.previewReq);
  const setPreviewReq = useAppStore((s) => s.setPreviewReq);
  useEffect(() => {
    if (!visible || !previewReq) return;
    setPreviewReq(null);
    // 评审覆盖层会挡住预览，先关掉（同 pendingTerminal 消费语义）
    setReviewPath(null);
    setReviewAction(null);
    setFocusMode(false);
    setRightOpen(true);
    setRightTab("preview");
    // PDF 是阅读动作：打开时自动进入专注内容（隐藏工作树），用户可随时 ⇲/Esc 还原
    if (previewReq.path.toLowerCase().endsWith(".pdf")) setRightExpanded(true);
    setPreview({
      path: previewReq.path,
      name: previewReq.name,
      root: previewReq.root ?? null,
    });
    setPreviewDirty(false);
  }, [visible, previewReq, setPreviewReq]);

  // 步骤胶囊「📁」交来的文件树切根请求：复用 enterCwd/externalCwd「真进入」机制，
  // 落地到活动标签启动栏（shell 存活时写 cd），文件树根随活动标签 cwd 切换
  const enterCwdReq = useAppStore((s) => s.enterCwdReq);
  const setEnterCwdReq = useAppStore((s) => s.setEnterCwdReq);
  useEffect(() => {
    if (!visible || !enterCwdReq) return;
    setEnterCwdReq(null);
    // 评审覆盖层/专注终端会挡住文件树，先退出（同 previewReq 消费语义）
    setReviewPath(null);
    setReviewAction(null);
    setFocusMode(false);
    setEnterCwd(enterCwdReq);
  }, [visible, enterCwdReq, setEnterCwdReq]);

  /** PDF 选段「整理为笔记」（§11.4 P2b）：反查归属项目 → 选段追加到笔记工作区
      notes/inbox.md（无活跃工作区则走一键开步链路创建）→ 终端预填启动。
      返回预览区展示的提示；任何失败都以提示形式返回，不静默。 */
  const organizePdfExcerpt = useCallback(
    async (
      text: string,
      page: number,
      fileName: string,
    ): Promise<PdfActionResult> => {
      const pdfPath = preview?.path;
      if (!pdfPath) return { ok: false, msg: "预览已关闭，请重新打开 PDF" };
      const owner = await invoke<ProjectDto | null>("pdf_owner_project", {
        pdfPath,
      });
      if (!owner) {
        return {
          ok: false,
          msg: "该 PDF 未登记为任何项目资源",
          action: { label: "去工作区页登记", run: () => setPage("workspaces") },
        };
      }
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: owner.path,
      });
      const cfg = read.config;
      // 笔记步骤定位规则（简单可靠）：优先 workspaceName === "lit-notes"（默认模板第二步）；
      // 用户改过工作区名时回落流水线第二步（文献精读通常排在检索之后）
      const step =
        cfg.steps.find((s) => s.workspaceName === "lit-notes") ?? cfg.steps[1];
      if (!step?.workspaceName) {
        return {
          ok: false,
          msg: "该项目流水线中没有笔记步骤：请把工作区名设为 lit-notes 的步骤，或保留流水线前两步",
        };
      }
      // 已有活跃工作区直接追加；没有则走一键开步链路（同 ProjectGroup.startStep）
      const all = await invoke<WorkspaceDto[]>("list_workspaces");
      const samePath = (a: string, b: string) =>
        a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
      let ws = all.find(
        (w) =>
          samePath(w.repoPath, owner.path) &&
          w.name === step.workspaceName &&
          w.status === "active",
      );
      if (!ws) {
        await invoke("ensure_git_repo", { path: owner.path });
        ws = await invoke<WorkspaceDto>("create_workspace", {
          repoPath: owner.path,
          name: step.workspaceName,
        });
        // TASK.md 为 best-effort（同一键开步语义）：失败不阻断选段写入
        // 步骤挂载技能（RX3b）：skills 非空时读库元数据渲染推荐技能段，失败只列技能名
        let skillMeta: Record<string, string> | undefined;
        if (step.skills.length > 0) {
          try {
            const lib = await invoke<SkillDto[]>("list_skills");
            skillMeta = Object.fromEntries(
              lib.map((skill) => [skill.name, skill.description]),
            );
          } catch {
            /* 技能库不可读时只列技能名 */
          }
        }
        try {
          await invoke("write_workspace_task_md", {
            worktreePath: ws.worktreePath,
            content: renderTaskMd(step, cfg, owner.path, undefined, skillMeta),
          });
        } catch {
          /* 简报仍可在 project.toml 与步骤「编辑简报」中查看 */
        }
      }
      // 出处：文件名 + 页码 + 本机日期（sv-SE 输出本地时区的 YYYY-MM-DD）
      const date = new Date().toLocaleDateString("sv-SE");
      const chunk = `\n## ${fileName} · 第 ${page} 页 · ${date}\n\n${text}\n`;
      await invoke("append_workspace_inbox", {
        worktreePath: ws.worktreePath,
        content: chunk,
      });
      // 跳终端预填启动（同 useOpenInTerminal：端口段 env + 上次配置 + 一次性 initialPrompt）
      const pairs = await invoke<[string, string][]>("workspace_env_for", {
        worktreePath: ws.worktreePath,
      });
      const last = (() => {
        try {
          return JSON.parse(
            localStorage.getItem(`ccode.wsLast.${ws.worktreePath}`) ?? "{}",
          ) as Partial<{ agentId: string; profileId: string; model: string }>;
        } catch {
          return {};
        }
      })();
      setPendingTerminal({
        cwd: ws.worktreePath,
        extraEnv: Object.fromEntries(pairs),
        title: ws.name,
        agentId: last.agentId,
        profileId: last.profileId,
        model: last.model,
        initialPrompt: ORGANIZE_NOTES_PROMPT,
      });
      return {
        ok: true,
        msg: `已写入工作区「${ws.name}」的 notes/inbox.md，并预填了终端启动（确认配置后点「启动」）`,
      };
    },
    [preview, setPage, setPendingTerminal],
  );

  // 会话页「进行中」反向跳转：聚焦指定标签
  const focusTabId = useAppStore((s) => s.focusTabId);
  const focusTab = useAppStore((s) => s.focusTab);
  useEffect(() => {
    if (visible && focusTabId) {
      if (tabs.some((t) => t.id === focusTabId)) activateTab(focusTabId);
      focusTab(null);
    }
  }, [visible, focusTabId, tabs, focusTab]);

  // 「已完成」已读集合剪枝：attention 离开 done（重新工作/退出/标签关闭）时复位，
  // 下次再 done 重新计入「要你管」
  useEffect(() => {
    for (const id of [...seenDoneRef.current]) {
      if (statuses[id]?.attention !== "done") seenDoneRef.current.delete(id);
    }
  }, [statuses]);

  // 长任务 OS 通知（P3）：attention 跃迁（非→待确认/已完成）且窗口未聚焦时发系统通知。
  // 只 watch 终端标签 statuses；对话页/工作区页的状态变化 v1 不通知。
  const notificationsEnabled = useAppStore(
    (s) => s.settings?.notificationsEnabled ?? true,
  );
  // 每标签上一次 attention（undefined = 基线未建立）与上次通知时间（去抖）
  const attentionPrevRef = useRef(new Map<string, TabStatus["attention"]>());
  const notifySentAtRef = useRef(new Map<string, number>());
  // macOS 切到别的应用时 document.hidden 不变，必须另跟 window focus/blur
  const windowFocusedRef = useRef(document.hasFocus());
  useEffect(() => {
    const onFocus = () => {
      windowFocusedRef.current = true;
    };
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    // 标签关闭后清掉基线/去抖记录，防 id 复用时沿用旧状态
    for (const id of [...attentionPrevRef.current.keys()]) {
      if (!(id in statuses)) {
        attentionPrevRef.current.delete(id);
        notifySentAtRef.current.delete(id);
      }
    }
    for (const [tabId, s] of Object.entries(statuses)) {
      const prev = attentionPrevRef.current.get(tabId);
      attentionPrevRef.current.set(tabId, s.attention);
      const kind = attentionTransition(prev, s.attention);
      if (!kind) continue;
      // 设置开关关闭时完全不请求权限、不发通知
      if (!notificationsEnabled) continue;
      if (!document.hidden && windowFocusedRef.current) continue;
      const now = Date.now();
      if (!debounceAllows(notifySentAtRef.current.get(tabId), now)) continue;
      notifySentAtRef.current.set(tabId, now);
      void fireAttentionNotification(
        notifyTitle(s.title, agentLabel(s.agentId)),
        notifyBody(kind),
        { tabId, cwd: s.cwd, kind },
      );
    }
  }, [statuses, notificationsEnabled]);

  // 可见性门控（优化 2）：只有可见 pane 的 PTY 推流，其余（含整页隐藏时全部）进后台缓冲。
  // 分屏时左右两个 pane 都可见，都推流。PTY 被替换（agent→shell 回落换新 id）时
  // statuses 变化会触发重新标记。
  useEffect(() => {
    for (const [tabId, s] of Object.entries(statuses)) {
      if (s.ptyId) {
        invoke("pty_set_visible", {
          ptyId: s.ptyId,
          visible:
            visible &&
            (tabId === activeId || (splitActive && tabId === splitTabId)),
        }).catch(() => {});
      }
    }
  }, [activeId, splitActive, splitTabId, statuses, visible]);

  /** 关闭标签守卫：仅「agent 还在跑」的标签弹确认（shell/已退出/未启动不弹）。
      存活判定以后端 pty_has_running_process 为准；命令不存在或报错时守卫静默跳过，不阻塞关闭。 */
  async function requestCloseTab(id: string) {
    const s = statusesRef.current[id];
    if (s?.running && s.ptyId) {
      try {
        const alive = await invoke<boolean>("pty_has_running_process", {
          ptyId: s.ptyId,
        });
        if (
          alive &&
          !(await confirmDialog("该标签的 Agent 还在运行，确认关闭并终止？", {
            danger: true,
          }))
        )
          return;
      } catch {
        /* 后端命令未就绪：静默跳过守卫 */
      }
    }
    doCloseTab(id);
  }

  function doCloseTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    let nextActiveId = activeId;
    if (next.length === 0) {
      // 至少保留一个标签
      const fresh: Tab = { id: crypto.randomUUID(), skipSeed: true };
      nextActiveId = fresh.id;
      setTabs([fresh]);
      setActiveId(fresh.id);
    } else {
      setTabs(next);
      if (id === activeId) {
        nextActiveId = next[Math.max(0, idx - 1)].id;
        setActiveId(nextActiveId);
      }
    }
    // 分屏修正：被关的是右 pane 标签，或关闭后活跃标签与右 pane 撞车时退出分屏
    if (splitTabId === id || splitTabId === nextActiveId) {
      setSplitTabId(null);
      setActivePane("left");
    }
    // 被关标签的 TerminalView 卸载时会自行杀掉 PTY（其 unmount 清理路径）
    setStatuses((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setSessionByTab((prev) => {
      const n = { ...prev };
      delete n[id];
      return n;
    });
    // run 脚本互斥登记随标签关闭释放
    for (const [wsId, tabId] of Object.entries(runningScriptsRef.current)) {
      if (tabId === id) setRunningScript(wsId, null);
    }
  }

  // 关窗守卫：还有 agent 在跑的标签时，关窗前统一确认一次；确认后放行（allowCloseRef 防重入）。
  // 后端命令未就绪时对应标签不计入，静默放行。
  const allowWindowCloseRef = useRef(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    win
      .onCloseRequested((event) => {
        if (allowWindowCloseRef.current) return;
        const candidates = Object.values(statusesRef.current).filter(
          (s) => s.running && s.ptyId,
        );
        if (candidates.length === 0) return;
        event.preventDefault();
        void (async () => {
          let alive = 0;
          for (const s of candidates) {
            try {
              if (
                await invoke<boolean>("pty_has_running_process", {
                  ptyId: s.ptyId,
                })
              )
                alive++;
            } catch {
              /* 命令未就绪：该标签不计入守卫 */
            }
          }
          if (
            alive > 0 &&
            !(await confirmDialog(
              `还有 ${alive} 个标签的 Agent 正在运行，确认退出并终止？`,
              { danger: true },
            ))
          )
            return;
          allowWindowCloseRef.current = true;
          // 正常路径走 window.close（触发 onCloseRequested 但被放行）；
          // close 被权限拒绝时兜底直接退出进程（process:default 已授权）
          await win.close().catch(() => exit(0));
        })();
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const railBtn =
    "flex h-7 w-7 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l2";

  // 运行中输入汇总（P5）：状态全部来自现有 statuses 上报，不新增轮询；
  // inputs 镜像进 store（terminalRunInputs），供工作区首页「待你处理」跨页聚合只读
  // （排序/分类由首页自行用 buildRunOverview 完成）。
  const setTerminalRunInputs = useAppStore((s) => s.setTerminalRunInputs);
  const runInputs: RunOverviewInput[] = useMemo(
    () =>
      tabs.map((t) => {
        const s = statuses[t.id];
        return {
          tabId: t.id,
          title: s?.title ?? "终端",
          agentId: s?.agentId ?? "",
          model: s?.model ?? "",
          cwd: s?.cwd ?? "",
          running: s?.running ?? false,
          shell: s?.shell ?? false,
          attention: s?.attention ?? null,
        };
      }),
    [tabs, statuses],
  );
  useEffect(() => {
    setTerminalRunInputs(runInputs);
  }, [runInputs, setTerminalRunInputs]);

  // 可合并 pill 数据：归属口径与 ProjectRail 一致（cwd 落工作树→其 repo；落 repo→该仓；
  // 注册项目兜底），健康检查只对当前项目的活跃工作区做（同工作区页 Promise.all 模式）
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = (await invoke<WorkspaceDto[]>("list_workspaces")).filter(
          (w) => w.status === "active",
        );
        let root: string | null = null;
        for (const w of active) {
          if (pathWithin(activeCwd, w.worktreePath)) {
            root = w.repoPath;
            break;
          }
        }
        if (!root) {
          for (const w of active) {
            if (pathWithin(activeCwd, w.repoPath)) {
              root = w.repoPath;
              break;
            }
          }
        }
        if (!root) {
          const projects = await invoke<ProjectDto[]>("list_projects").catch(
            () => [] as ProjectDto[],
          );
          for (const p of projects) {
            if (pathWithin(activeCwd, p.path)) {
              root = p.path;
              break;
            }
          }
        }
        const rootPath = root;
        const candidates = rootPath
          ? active.filter(
              (w) =>
                pathWithin(w.repoPath, rootPath) &&
                pathWithin(rootPath, w.repoPath),
            )
          : [];
        const names = (
          await Promise.all(
            candidates.map(async (w) => {
              try {
                const h = await invoke<WorkspaceHealthDto>("workspace_health", {
                  id: w.id,
                });
                return h.readyToMerge ? w.name : null;
              } catch {
                return null;
              }
            }),
          )
        ).filter((n): n is string => n != null);
        if (!cancelled) setMergeReadyWs(names);
      } catch {
        if (!cancelled) setMergeReadyWs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCwd, visible, refreshKey, fsChangeTick, reviewPath, wsPillTick]);

  // 工作区归档后刷新 pill（工作区集合已变）
  useEffect(() => {
    let un: (() => void) | undefined;
    listen("ws-archived", () => setWsPillTick((t) => t + 1)).then(
      (u) => (un = u),
    );
    return () => un?.();
  }, []);

  return (
    <div
      ref={terminalRootRef}
      className="terminal-workbench relative flex h-full bg-canvas"
    >
      {/* 左栏：工作树（专注终端/专注内容下整体隐藏；无手动收起态） */}
      {!focusMode && !rightExpanded && (
        <div className="flex w-60 shrink-0 flex-col border-r border-hairline bg-rail2">
          <div className="flex h-9 shrink-0 items-center gap-2 px-2">
            <span className="mr-auto text-xs font-medium text-l3">
              工作树
            </span>
            <button
              onClick={() => setShowHidden((v) => !v)}
              title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
              className={`flex h-7 w-7 items-center justify-center rounded text-xs hover:bg-white/5 ${
                showHidden ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              .*
            </button>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              title="刷新"
              className={railBtn}
            >
              ⟳
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <FileTree
              cwd={activeCwd}
              showHidden={showHidden}
              refreshKey={refreshKey}
              onOpenFile={openPreview}
              onOpenTerminal={openTerminalAt}
              onFsEvent={bumpFsChangeTick}
              onEnterProject={setEnterCwd}
              onRootChange={closePreviewForRootChange}
              belowRecent={
                /* 项目区：当前标签 cwd 所属项目的主文件夹 + 活跃工作区，点击切根复用 enterCwd 链路 */
                <ProjectRail
                  cwd={activeCwd}
                  pageVisible={visible}
                  refreshKey={refreshKey}
                  agentRunning={statuses[focusedId]?.running ?? false}
                  tabs={Object.values(statuses).map((s) => ({
                    cwd: s.cwd,
                    running: s.running,
                    attention: s.attention,
                  }))}
                  onEnter={setEnterCwd}
                />
              }
            />
          </div>
        </div>
      )}

      {/* 中带：终端标签区 */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 顶部标签条：常驻中带顶部，专注终端下也保留在原位 */}
        <div className="flex h-9 items-center gap-1 overflow-x-auto border-b border-hairline bg-strip px-2">
          {tabs.map((t) => {
            const s = statuses[t.id];
            const active = t.id === activeId;
            // 注意力点：仅 工作中/待确认/已完成（未查看）有状态时才渲染，无状态/空闲不渲染（降噪）；
            // 「已完成」点击跳转过该标签即已读消除（seenDoneRef）。
            // 与关闭 × 一样只在悬停 / 激活 / 键盘聚焦（focus-within）时显现。
            const attentionDot =
              s?.attention === "working"
                ? { cls: "text-ok-text animate-pulse", tip: "工作中" }
                : s?.attention === "confirm"
                  ? { cls: "text-warn-text", tip: "待确认" }
                  : s?.attention === "done" && !seenDoneRef.current.has(t.id)
                    ? { cls: "text-link", tip: "已完成，等待输入" }
                    : null;
            return (
              <div
                key={t.id}
                onClick={() => activateTab(t.id)}
                className={`group/tab flex h-9 w-[130px] min-w-[100px] shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-xs ${
                  active
                    ? "border-cta text-l1"
                    : "border-transparent text-l3 hover:text-l1"
                }`}
              >
                {attentionDot && (
                  <span
                    className={`shrink-0 text-[10px] ${attentionDot.cls} ${
                      active
                        ? ""
                        : "invisible group-hover/tab:visible group-focus-within/tab:visible"
                    }`}
                    title={attentionDot.tip}
                  >
                    ●
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {s?.title ?? "终端"}
                </span>
                {t.restored && (
                  <span className="shrink-0 rounded bg-inset px-1 text-[10px] text-link">
                    可恢复
                  </span>
                )}
                {splitActive && t.id === splitTabId && (
                  <span
                    className="shrink-0 rounded bg-inset px-1 text-[10px] text-l3"
                    title="分屏右侧对照（点击交换到左侧）"
                  >
                    ◧
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void requestCloseTab(t.id);
                  }}
                  aria-label="关闭标签"
                  className={`shrink-0 text-l4 hover:text-err-text focus-visible:visible ${active ? "" : "invisible group-hover/tab:visible"}`}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            onClick={() => addTab()}
            title="新建终端标签"
            className="shrink-0 rounded px-1.5 text-sm text-l4 hover:text-l1"
          >
            ＋
          </button>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* 当前项目状态 pill（P1b 参考图 2）：有可合并工作区才显示，纯状态不交互（inset 底 + 语义色小点） */}
            {mergeReadyWs.length > 0 && (
              <span
                className="flex items-center gap-1 rounded bg-inset px-2 py-0.5 text-xs text-l2"
                title={`可合并的工作区：${mergeReadyWs.join("、")}\n从右侧「改动」页签或工作区页进入评审合并`}
              >
                <span className="text-[10px] text-ok-text">●</span>
                {mergeReadyWs.length > 1
                  ? `${mergeReadyWs.length} 个可合并`
                  : "可合并"}
              </span>
            )}
            <button
              type="button"
              onClick={toggleSplit}
              disabled={!splitActive && tabs.length < 2}
              title={
                splitActive
                  ? "退出分屏"
                  : "分屏对比：左侧当前标签，右侧任选对照标签（需要至少两个标签）"
              }
              className={`rounded px-2 py-0.5 text-xs disabled:opacity-40 ${
                splitActive ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              ◧ 分屏
            </button>
            <button
              type="button"
              onClick={() => setRightOpen(true)}
              title="打开当前任务工作台（对话 / 文件 / 改动）"
              aria-label="打开当前任务工作台"
              className={`rounded px-2 py-0.5 text-xs ${
                rightOpen ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              ◫ 工作台
            </button>
            <button
              onClick={() => setFocusMode((v) => !v)}
              title={
                focusMode
                  ? "退出专注终端（Esc，恢复左右栏）"
                  : "专注终端（隐藏左右栏，Esc 退出）"
              }
              className={`rounded px-2 py-0.5 text-xs ${
                focusMode ? "text-l1" : "text-l4 hover:text-l2"
              }`}
            >
              ⤢ 专注终端
            </button>
            {/* 专注终端下标签内状态条隐藏，停止/恢复/对话等动作收进此菜单 */}
            {focusMode && (
              <button
                type="button"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFocusMenu({ x: r.right, y: r.bottom + 4 });
                }}
                title="终端操作（停止/恢复/接力/对话/查找/修改）"
                aria-label="终端操作"
                className="rounded px-2 py-0.5 text-xs text-l4 hover:text-l2"
              >
                ⋯
              </button>
            )}
          </span>
        </div>
        <div
          ref={splitAreaRef}
          className={`min-h-0 flex-1${splitActive ? " flex" : ""}`}
        >
          {/* 所有标签保持挂载，仅隐藏不可见标签，运行中的会话与 scrollback 得以保留。
              分屏时靠 flex order 把活跃标签（左）与对照标签（右）排到分隔条两侧，
              标签在 pane 间切换只是显隐与排序变化，TerminalView 不重挂载、xterm 不重建 */}
          {tabs.map((t) => {
            const isLeftPane = splitActive && t.id === activeId;
            const isRightPane = splitActive && t.id === splitTabId;
            const tabVisible =
              visible &&
              (splitActive ? isLeftPane || isRightPane : t.id === activeId);
            // 可见 pane 统一 flex 纵排：pane 小头 + 终端主体；单标签时小头不渲染，布局不变
            const paneClass = !tabVisible
              ? "hidden"
              : isLeftPane
                ? "flex h-full min-w-0 shrink-0 flex-col"
                : isRightPane
                  ? "flex h-full min-w-0 flex-1 flex-col"
                  : "flex h-full flex-col";
            const paneStyle = isLeftPane
              ? { order: 0, width: `${splitPct}%` }
              : isRightPane
                ? { order: 2 }
                : undefined;
            const view = (
              <TerminalView
                visible={tabVisible}
                primaryFocus={t.id === focusedId}
                rightOpen={rightOpen}
                layoutKey={`${focusMode}-${rightOpen}-${Math.round(rightWidth)}-${rightExpanded}-${splitActive ? `split${Math.round(splitPct)}` : "single"}`}
                gitTotals={t.id === focusedId ? gitTotals : null}
                tabId={t.id}
                skipSeed={t.skipSeed}
                initialCwd={t.initialCwd}
                initialExtraEnv={t.initialExtraEnv}
                initialTitle={t.initialTitle}
                initialAgentId={t.initialAgentId}
                initialProfileId={t.initialProfileId}
                initialModel={t.initialModel}
                resumeSessionId={t.resumeSessionId}
                autoStart={t.autoStart}
                prefillCommand={t.prefillCommand}
                shellOnly={t.shellOnly}
                initialPrompt={t.initialPrompt}
                restored={t.restored}
                externalCwd={t.id === focusedId ? enterCwd : null}
                onConsumeExternalCwd={consumeExternalCwd}
                onStatus={reportStatus}
                onSessionUpdate={reportSession}
                onHandoff={setHandoffSource}
                focusMode={focusMode}
                onActions={registerActions}
                onRestoreComplete={finishRestore}
                onConsumeResume={clearResumeSession}
              />
            );
            return (
              <div
                key={t.id}
                className={paneClass}
                style={paneStyle}
                onPointerDownCapture={
                  splitActive && tabVisible
                    ? () => setActivePane(isRightPane ? "right" : "left")
                    : undefined
                }
              >
                {/* pane 小头（32px，仅分屏时渲染）：左 pane 标签名 / 右 pane 对照选择器，
                    各带「关闭该 pane」；pane 级操作集中在这里，全局工具行不变。
                    小头与主体都带固定 key，进出分屏只是插入/移除兄弟节点，
                    pane-body 与其中的 TerminalView 始终原位更新、不重挂载 */}
                {(isLeftPane || isRightPane) && (
                  <div
                    key="pane-head"
                    className="flex h-8 shrink-0 items-center gap-1.5 border-b border-hairline bg-strip px-2"
                  >
                    {isRightPane ? (
                      <>
                        <span className="shrink-0 text-[11px] text-l4">
                          对照
                        </span>
                        <select
                          value={splitTabId ?? ""}
                          onChange={(e) => setSplitTabId(e.target.value)}
                          className="h-6 min-w-0 flex-1 rounded border border-field bg-inset px-1.5 text-xs text-l2 outline-none focus:border-l4"
                          title="选择右侧对照显示的标签"
                        >
                          {tabs
                            .filter((other) => other.id !== activeId)
                            .map((other) => (
                              <option key={other.id} value={other.id}>
                                {statuses[other.id]?.title ?? "终端"}
                              </option>
                            ))}
                        </select>
                      </>
                    ) : (
                      <>
                        <span className="shrink-0 text-[11px] text-l4">
                          当前
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-l2">
                          {statuses[t.id]?.title ?? "终端"}
                        </span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => closePane(isRightPane ? "right" : "left")}
                      title={
                        isRightPane
                          ? "关闭此 pane（退出分屏，保留当前标签）"
                          : "关闭此 pane（退出分屏，切换到对照标签）"
                      }
                      aria-label="关闭此 pane"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l1"
                    >
                      ×
                    </button>
                  </div>
                )}
                <div key="pane-body" className="min-h-0 flex-1">
                  {view}
                </div>
              </div>
            );
          })}
          {splitActive && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整分屏比例"
              title="拖动调整分屏比例；双击恢复对半"
              style={{ order: 1 }}
              onPointerDown={startSplitResize}
              onDoubleClick={() => {
                setSplitPct(50);
                localStorage.setItem(SPLIT_PCT_KEY, "50");
              }}
              className="group relative w-1.5 shrink-0 cursor-col-resize"
            >
              {/* 平时透明极细（w-0.5），悬停才显色（waveterm 手法）；外层 w-1.5 只是抓取热区，拖拽逻辑不变 */}
              <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
            </div>
          )}
        </div>
        {/* 专注内容：右栏铺满即表达主次，中带不加压暗遮罩（v3.44 用户否决压黑） */}
      </div>

      {/* 右侧面板：当前对话 / 文件预览 / 改动（专注终端下隐藏） */}
      {rightOpen && !focusMode && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧面板宽度"
            title="拖动调整宽度；双击恢复默认宽度"
            onPointerDown={startRightResize}
            onDoubleClick={() => {
              const width = clampRightWidth(RIGHT_PANEL_DEFAULT_WIDTH, false);
              setRightExpanded(false);
              setRightWidth(width);
              normalRightWidthRef.current = width;
              localStorage.setItem(
                RIGHT_PANEL_WIDTH_KEY,
                String(Math.round(width)),
              );
            }}
            className="group relative w-1.5 shrink-0 cursor-col-resize"
          >
            {/* 平时透明极细（w-0.5），悬停才显色（waveterm 手法）；外层 w-1.5 只是抓取热区，拖拽逻辑不变 */}
            <span className="absolute inset-y-0 left-0.5 w-0.5 bg-transparent transition-colors group-hover:bg-cta" />
          </div>
          <div
            style={{ width: rightWidth }}
            className="flex shrink-0 flex-col border-l border-hairline bg-raised"
          >
            {/* 页签与面板头部合并为一行（走查去重）：左侧页签，右侧按页签透出上下文
                （对话 = 会话状态小字 + 完整回放入口）与面板动作；不再单设「工作台」标题行，
                对话区也不再重复一行标题/agent/状态头部（信息仍在，收进本行右侧） */}
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline bg-raised px-2">
              {RIGHT_TABS.map(({ key: k, label, symbol }) => {
                const gitBadge =
                  k === "git" && gitTotals && gitTotals.add + gitTotals.del > 0
                    ? gitTotals.add + gitTotals.del
                    : null;
                // 对话计数徽标（P1b）：实时视图消息数，有界 50 条封顶时显示 50+
                const dialogueCount =
                  k === "dialogue" ? (activeSession?.conv.length ?? 0) : 0;
                return (
                  <button
                    key={k}
                    onClick={() => setRightTab(k)}
                    onDoubleClick={toggleRightExpanded}
                    title={`${label}；双击${rightExpanded ? "退出专注内容" : "进入专注内容"}`}
                    className={`flex h-8 shrink-0 items-center gap-1 rounded px-2.5 text-xs ${
                      rightTab === k
                        ? "bg-seg-sel text-l1"
                        : "text-l3 hover:text-l1"
                    }`}
                  >
                    <span className="text-[11px] text-l4">{symbol}</span>
                    {label}
                    {k === "dialogue" && dialogueCount > 0 && (
                      <span
                        className="ml-1 rounded bg-inset px-1 text-[11px] text-l3"
                        title="实时视图最多保留最近 50 条"
                      >
                        {dialogueCount >= 50 ? "50+" : dialogueCount}
                      </span>
                    )}
                    {k === "preview" && previewDirty && (
                      <span className="ml-1 text-l3" title="有未保存的修改">
                        ●
                      </span>
                    )}
                    {gitBadge && (
                      <span className="ml-1 rounded bg-ok px-1 text-ok-text">
                        +{gitBadge}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* 右侧上下文区：按页签透出对应信息（对话 = 状态点 + 标题/agent/会话/状态
                  一行小字 + 完整回放；文件/改动的上下文由各自内容头部承担），
                  末端固定专注内容与收起按钮；空间不足时小字截断、完整信息在悬浮提示 */}
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                {rightTab === "dialogue" && (
                  <>
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        statuses[focusedId]?.running
                          ? "bg-ok-text"
                          : activeSession?.state === "timeout"
                            ? "bg-warn-text"
                            : "bg-l4"
                      }`}
                    />
                    <span
                      className="min-w-0 truncate text-[11px] text-l4"
                      title={
                        activeSession?.sessionId
                          ? `会话 ${activeSession.sessionId}`
                          : undefined
                      }
                    >
                      <span className="text-l2">
                        {activeSession?.title ||
                          statuses[focusedId]?.title ||
                          "当前对话"}
                      </span>
                      {" · "}
                      {activeSession?.agentId
                        ? agentLabel(activeSession.agentId)
                        : statuses[focusedId]?.agentId
                          ? agentLabel(statuses[focusedId].agentId)
                          : "尚未启动"}
                      {activeSession?.sessionId
                        ? ` · ${activeSession.sessionId.slice(0, 8)}`
                        : ""}
                      {activeSession?.state === "detecting"
                        ? " · 识别中"
                        : activeSession?.state === "timeout"
                          ? " · 等待关联"
                          : activeSession?.file
                            ? statuses[focusedId]?.running
                              ? " · 同步中"
                              : " · 已结束"
                            : ""}
                    </span>
                    <button
                      type="button"
                      disabled={
                        !activeSession?.sessionId || !activeSession.agentId
                      }
                      onClick={() => {
                        if (!activeSession?.sessionId || !activeSession.agentId)
                          return;
                        setOpenSessionReq({
                          agent: activeSession.agentId,
                          sessionId: activeSession.sessionId,
                        });
                        setPage("sessions");
                      }}
                      className="shrink-0 rounded px-2 py-1 text-xs text-l2 hover:bg-white/5 hover:text-l1 disabled:opacity-40"
                    >
                      完整回放
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={toggleRightExpanded}
                  title={
                    rightExpanded
                      ? "退出专注内容（Esc，恢复工作树分栏）"
                      : "专注内容（暂时隐藏工作树，右栏铺满，Esc 退出）"
                  }
                  className="flex size-7 shrink-0 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l1"
                >
                  {rightExpanded ? "⇲" : "⇱"}
                </button>
                <button
                  onClick={closeRightPanel}
                  title="收起工作台"
                  className="flex size-7 shrink-0 items-center justify-center rounded text-xs text-l4 hover:bg-white/5 hover:text-l1"
                >
                  ×
                </button>
              </span>
            </div>
            <div
              className={
                rightTab === "dialogue"
                  ? "flex min-h-0 flex-1 flex-col"
                  : "hidden"
              }
            >
              <div className="relative min-h-0 flex-1">
                <div
                  ref={sessionScrollRef}
                  onScroll={onDialogueScroll}
                  className="h-full overflow-auto p-3"
                >
                  {!activeSession || activeSession.state === "idle" ? (
                    <p className="text-sm text-l4">
                      启动 Agent 后将在这里同步当前对话
                    </p>
                  ) : activeSession.state === "detecting" ? (
                    <p className="text-sm text-l4">正在识别当前对话…</p>
                  ) : activeSession.state === "timeout" &&
                    !activeSession.file ? (
                    <p className="text-sm text-l4">
                      暂未识别到对话，后台仍会自动重试
                    </p>
                  ) : activeSession.conv.length === 0 ? (
                    <p className="text-sm text-l4">等待第一条对话…</p>
                  ) : (
                    <ConversationView messages={activeSession.conv} compact />
                  )}
                </div>
                {dialogueHasNew && (
                  <button
                    type="button"
                    onClick={scrollDialogueToBottom}
                    className="absolute bottom-3 right-3 rounded border border-field bg-strip px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    有新消息 ↓
                  </button>
                )}
              </div>
            </div>
            <div
              className={
                rightTab === "preview"
                  ? "flex min-h-0 flex-1 flex-col"
                  : "hidden"
              }
            >
              {preview ? (
                <Suspense
                  fallback={
                    <div className="min-h-0 flex-1 px-4">
                      <LoadingRows />
                    </div>
                  }
                >
                  {/\.pdf$/i.test(preview.path) ? (
                    <PdfPreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                      onAskAi={askAiFromPdf}
                      onOrganize={organizePdfExcerpt}
                    />
                  ) : /\.docx$/i.test(preview.path) ? (
                    <DocxPreview
                      path={preview.path}
                      cwdHint={preview.root ?? activeCwd}
                    />
                  ) : (
                    <FilePreviewEditor
                      path={preview.path}
                      root={preview.root ?? activeCwd}
                      onDirtyChange={setPreviewDirty}
                      onDiscuss={discussMdExcerpt}
                    />
                  )}
                </Suspense>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="p-3">
                    <p className="text-sm text-l4">
                      在左侧工作树中单击文件预览
                    </p>
                  </div>
                </div>
              )}
            </div>
            {/* 改动面板保持挂载：右栏打开期间持续轮询，页签徽标才有数据 */}
            <div
              className={
                rightTab === "git" ? "flex min-h-0 flex-1 flex-col" : "hidden"
              }
            >
              <GitPanel
                cwd={activeCwd}
                visible={visible && rightOpen}
                refreshKey={fsChangeTick}
                onTotals={reportGitTotals}
                onOpenReview={(path) => {
                  setReviewAction(null);
                  setReviewPath(path);
                }}
              />
            </div>
          </div>
        </>
      )}

      {reviewPath && (
        <WorkspaceReviewView
          worktreePath={reviewPath}
          initialAction={reviewAction}
          initialActionKey={reviewRequestId}
          onClose={() => {
            setReviewPath(null);
            setReviewAction(null);
            setReviewRequestId(null);
          }}
        />
      )}

      {focusMenu && (
        <ContextMenu
          x={focusMenu.x}
          y={focusMenu.y}
          alignRight
          onClose={() => setFocusMenu(null)}
          items={focusMenuItems()}
        />
      )}
      {handoffSource && (
        <HandoffPicker
          source={handoffSource}
          onClose={() => setHandoffSource(null)}
        />
      )}
    </div>
  );
}
