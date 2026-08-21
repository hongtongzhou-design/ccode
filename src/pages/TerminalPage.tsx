import {
  memo,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { exit } from "@tauri-apps/plugin-process";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../store";
import { IS_MAC } from "../hotkeys";
import {
  escapeShellPath,
  firstImageItem,
  imageExtFromMime,
  joinDroppedPaths,
  pasteImageFeedback,
} from "../terminal-input";
import { AGENTS } from "../types";
import ConversationView from "../components/ConversationView";
import { confirmDialog, alertDialog } from "../components/ConfirmDialog";
import ContextMenu from "../components/ContextMenu";
import FileTree from "../components/FileTree";
import GitPanel, { type GitSummary } from "../components/GitPanel";
import TerminalStatusBar, { fmtTokens } from "../components/TerminalStatusBar";
import HandoffPicker, { type HandoffSource } from "../components/HandoffPicker";
import DigestPicker from "../components/DigestPicker";
import { LoadingRows, hoverRevealClass } from "../components/PageFrame";
import ProjectRail from "../components/ProjectRail";
import WorkspaceReviewView from "../components/WorkspaceReviewView";
import ReaderOverlay from "../components/ReaderOverlay";
import { renderTaskMd } from "../pipeline-start";
import { formatPdfExcerptPrompt, readerReuseKey } from "../reader";
import { defaultCommitMessage } from "../git-commit-message";
import { pickResumeProfile } from "../resume-profile";
import { ORGANIZE_NOTES_PROMPT } from "../pipeline-presets";
import { XTERM_PALETTES, resolvePaletteId } from "../terminal-palettes";
import { isLightTheme } from "../themes";
import {
  launchModelNote,
  looksLikeModelId,
  modelOnProfileSwitch,
} from "../model-switch";
import { isSoftwareWebGL } from "../diagnostics";
import {
  attentionTransition,
  debounceAllows,
  NOTIFY_BODY,
  notifyTitle,
} from "../notify";
import {
  parseRecoverableTerminalState,
  serializeRecoverableTerminalState,
  TERMINAL_TABS_STORAGE_KEY,
} from "../terminal-tab-persistence";
import { clampTabDragDx, tabDragTarget } from "../tab-drag";
import { directoryUnavailableMessage } from "../terminal-cwd";
import type { RunOverviewInput } from "../run-overview";
import type {
  ChatMessageDto,
  ConversationPageDto,
  GitCommitResultDto,
  ProjectConfigReadDto,
  ProjectDto,
  SessionMetaDto,
  SkillDto,
  McpServerDto,
  SessionUsageDto,
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
export interface TabStatus {
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
  /** agent 启动成功时刻（ms epoch；终端状态栏运行时长用；shell/未启动为 null） */
  startedAt: number | null;
}

/** TerminalView 暴露给标签条 ⋯ 菜单的动作表（回调经 ref 转发，始终最新） */
export interface FocusTabActions {
  stop: () => void;
  resume: () => void;
  openConversationPage: () => void;
  search: () => void;
  modify: () => void;
  /** 往 xterm 画面写一行浅灰日志（状态栏 Commit & Push 的回显；走终端缓冲区不经 PTY，
      运行中的 TUI 会在下一帧覆盖它——只是即时反馈，不是持久日志） */
  logLine: (text: string) => void;
  /** 状态栏 📂 浮层改工作目录（仅未启动时开放；cwd state 单一出处在 TerminalView） */
  setCwd: (cwd: string) => void;
  chooseCwd: () => void;
}

/** TerminalView 上报的当前对话联动数据（右侧「对话」页签与阅读区 Agent 栏渲染用） */
export interface SessionLinkState {
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
// 右栏最大宽度不写死像素：随窗口自由拉宽，只给中带终端保留最小可用宽度
const TERMINAL_MIN_RESERVE = 340;
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
 *  带「去处理」动作按钮（ccode.attention，App.tsx 注册）；extra 携带 tabId/cwd，
 *  onAction 路由：聚焦对应标签（只有待确认一种通知）。 */
async function fireAttentionNotification(
  title: string,
  body: string,
  extra: { tabId: string; cwd: string },
) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;
  sendNotification({ title, body, actionTypeId: "ccode.attention", extra });
}

/** 七套深色 + 七套浅色主题对应的 xterm 底色/前景（取自 App.css 各主题调色板）。
 *  ANSI 16 色 + 光标 + 选区由调色板预设提供，并按主题亮暗自动取深/浅套
 *  （见 terminal-palettes.ts 的 resolvePaletteId）。 */
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

/** 终端 16 色调色板预设已抽至 src/terminal-palettes.ts（设置页预览共享） */

/** 底/字色取自主题表，ANSI 16 色 + cursor + selectionBackground 全部由调色板提供。
 *  调色板先经 resolvePaletteId 按主题亮暗解析：浅色主题拿到深色向预设时自动换 twin，
 *  避免近白底上出现 white/brightWhite 隐形、深藏蓝选区压死选中文字。 */
function buildXtermTheme(
  themeId: string,
  paletteId?: string,
): { background: string; foreground: string } & Record<string, string> {
  const palette =
    XTERM_PALETTES[resolvePaletteId(paletteId, isLightTheme(themeId))];
  return {
    ...(XTERM_BG_FG[themeId] ?? XTERM_BG_FG.midnight),
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
  readonly,
  restored,
  stepClaimName,
  externalCwd,
  onConsumeExternalCwd,
  onStatus,
  onSessionUpdate,
  onHandoff,
  onDigest,
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
  /** 「聊想法」只读模式：pty_spawn 透传（支持的 CLI 注入只读/计划模式参数） */
  readonly?: boolean;
  /** 应用重启后恢复出的占位标签；用户明确操作前不启动 PTY。 */
  restored?: boolean;
  /** 步骤认领（「跟 AI 商量一下」）：launch 时以最终 agent/cwd 登记会话归该步骤 */
  stepClaimName?: string;
  /** 最近项目「真进入」：把目标目录注入活动标签的启动栏（TerminalView 消费后清空） */
  externalCwd?: string | null;
  onConsumeExternalCwd?: () => void;
  /** 上报回调带 tabId（父级共享 useCallback，memo 稳定） */
  onStatus: (id: string, s: TabStatus) => void;
  onSessionUpdate: (id: string, s: SessionLinkState) => void;
  /** 「◈ 接力到…」：把当前关联会话交给父级的接力目标选择器 */
  onHandoff?: (source: HandoffSource) => void;
  /** 「◈ 提炼接力…」：把当前关联会话交给父级的提炼接力选择器（AI 蒸馏简报） */
  onDigest?: (source: HandoffSource) => void;
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
    term.options.fontFamily = `'${settings.terminalFontFamily ?? "JetBrains Mono"}', 'JetBrains Mono', 'SF Mono', Menlo, 'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace`;
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
  // 换 agent 后按「显式默认 > 上次使用 > 该 agent 首个配置」预选（v3.88）。
  // 这才是用户心里的「启用某个配置」——不加 enabled 布尔（与注入语义打架，见 settings.rs）
  useEffect(() => {
    if (running || profileId) return;
    const pick =
      settings?.defaultProfiles?.[agentId] ||
      localStorage.getItem(`ccode.lastProfile.${agentId}`) ||
      "";
    const ok = profiles.find(
      (p) => p.id === pick && p.agent === agentId,
    )?.id;
    // 兜底挑首个时跳过隐藏项（隐藏的本意就是「别默认落到我头上」）；
    // 全被隐藏时仍从隐藏项里取，好过留空
    const visible = profiles.filter(
      (p) => p.agent === agentId && !hiddenProfiles.includes(p.id),
    );
    setProfileId(
      ok ??
        visible[0]?.id ??
        profiles.find((p) => p.agent === agentId)?.id ??
        "",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles, settings?.defaultProfiles, settings?.hiddenProfiles]);
  const [model, setModel] = useState(initialModel ?? saved.model ?? "");
  const selectedProfile = profiles.find(
    (p) => p.id === profileId && p.agent === agentId,
  );
  // 模型 combo：下拉开合状态 + 选项来源（profile 预设 + 本 agent 历史，去重）
  const [modelOpen, setModelOpen] = useState(false);
  // 换 profile 时保留了手填模型：说明行据此提示「仍按原样注入」（选中预设即消）
  const [modelKept, setModelKept] = useState(false);
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
  const [cwdIssue, setCwdIssue] = useState<string | null>(null);
  const [cwdChecking, setCwdChecking] = useState(false);
  const cwdCheckSeqRef = useRef(0);

  async function checkWorkingDirectory(path = cwd): Promise<boolean> {
    const seq = ++cwdCheckSeqRef.current;
    setCwdChecking(true);
    try {
      await invoke("list_dir", { path, showHidden: false });
      if (seq === cwdCheckSeqRef.current) setCwdIssue(null);
      return true;
    } catch {
      if (seq === cwdCheckSeqRef.current) setCwdIssue(path);
      return false;
    } finally {
      if (seq === cwdCheckSeqRef.current) setCwdChecking(false);
    }
  }

  function setWorkingDirectory(path: string) {
    const next = path.trim();
    if (!next) return;
    cwdCheckSeqRef.current += 1;
    setCwd(next);
    setCwdChecking(false);
    setCwdIssue(null);
    setError(null);
    setBarExpanded(true);
  }

  async function chooseWorkingDirectory() {
    const selected = await openDirectoryDialog({ directory: true, multiple: false });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (typeof path === "string" && path.trim()) setWorkingDirectory(path);
  }

  async function returnToHomeDirectory() {
    setWorkingDirectory("~");
    await checkWorkingDirectory("~");
  }
  // 一键开步的首条指令：开步预填过就展示编辑框；注入成功即清除（一次性）
  const [promptText, setPromptText] = useState(presetPrompt ?? "");
  const [showPrompt, setShowPrompt] = useState(!!presetPrompt);
  const [running, setRunning] = useState(false); // agent 正在运行
  const [shellActive, setShellActive] = useState(false); // 当前接的是 shell
  const [exited, setExited] = useState(false);
  /** agent 启动成功时刻（状态栏运行时长；shell/未启动为 null） */
  const [startedAt, setStartedAt] = useState<number | null>(null);
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
  // 终端画布右键菜单（复制/粘贴/全选/清屏/查找）
  const [termCtxMenu, setTermCtxMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // 粘贴图片/拖入文件后的瞬态轻反馈（3s 自动消，重贴重置计时）
  const [inputNote, setInputNote] = useState<string | null>(null);
  const inputNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 输入侧动作的瞬态轻反馈（参考配置页 notice 模式，只是更轻） */
  function flashInputNote(text: string) {
    setInputNote(text);
    if (inputNoteTimer.current) clearTimeout(inputNoteTimer.current);
    inputNoteTimer.current = setTimeout(() => setInputNote(null), 3000);
  }

  /** 剪贴板图片 → 落盘（save_clipboard_image）→ 绝对路径转义写进 PTY
      （「路径文本」是九家 CLI 通吃的图片输入方式，各家升级行为见 matrix §11） */
  async function pasteImageFile(file: File) {
    const id = ptyIdRef.current;
    if (!id) {
      flashInputNote("终端未启动，无法粘贴");
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const path = await invoke<string>("save_clipboard_image", {
        bytes: Array.from(new Uint8Array(buf)),
        ext: imageExtFromMime(file.type),
      });
      await invoke("pty_write", { ptyId: id, data: escapeShellPath(path) }).catch(
        () => {},
      );
      flashInputNote(pasteImageFeedback(path));
    } catch (reason) {
      flashInputNote(`粘贴图片失败：${String(reason)}`);
    }
  }

  /** 右键「粘贴」：先试 navigator.clipboard.read() 找图片条目（Chromium 支持）；
      不支持/无图回落 readText 纯文本写 PTY（多行由 Rust 端自动 bracketed paste 包裹） */
  async function pasteFromClipboard() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          await pasteImageFile(new File([blob], "clipboard", { type: imgType }));
          return;
        }
      }
    } catch {
      /* 当前 webview 不支持 read() 或权限被拒：回落文本 */
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const id = ptyIdRef.current;
      if (id)
        await invoke("pty_write", { ptyId: id, data: text }).catch(() => {});
    } catch {
      flashInputNote("无法读取剪贴板");
    }
  }

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
      setTermCtxMenu(null);
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
  // 「隐藏」的配置：只在启动栏下拉里沉到「更多」分组，不影响可用性
  const hiddenProfiles = settings?.hiddenProfiles ?? [];
  const [skillCount, setSkillCount] = useState(0);
  // 当前 agent 已启用的技能清单（技能页开关同步）；点击 pill 展开，一键使用
  const [agentSkills, setAgentSkills] = useState<SkillDto[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  // 当前 agent 已分发的 MCP server 清单（MCP 页开关同步）；点击 pill 展开，一键提及/管理
  const [agentMcps, setAgentMcps] = useState<McpServerDto[]>([]);
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false);
  // 高级启动项默认收起：主栏只回答「用谁、用哪个模型、在哪运行」；
  // 首条指令/技能/MCP 仍保留原能力，按需从「⋯」展开。
  const [advancedLaunchOpen, setAdvancedLaunchOpen] = useState(false);
  // 向上弹出菜单的锚点与动态限高：固定 224px 在锚点上方空间不足时会顶出屏幕
  const skillAnchor = useRef<HTMLSpanElement>(null);
  const mcpAnchor = useRef<HTMLSpanElement>(null);
  const [skillMenuMaxH, setSkillMenuMaxH] = useState(224);
  const [mcpMenuMaxH, setMcpMenuMaxH] = useState(224);

  /** 向上弹出菜单的限高：锚点上方可用空间 - 8px 边距，夹在 [96, 224] */
  function upMaxH(anchor: HTMLElement | null) {
    if (!anchor) return 224;
    return Math.max(
      96,
      Math.min(224, Math.floor(anchor.getBoundingClientRect().top) - 8),
    );
  }

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
      invoke("pty_write", { ptyId: activePtyId, data: text }).catch(() => {});
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
      invoke("pty_write", { ptyId: activePtyId, data: text }).catch(() => {});
    } else {
      setShowPrompt(true);
      setPromptText((t) => (t ? `${t}\n${text}` : text));
    }
    setMcpMenuOpen(false);
  }

  /** 技能清单 pill（展开/收缩启动栏共用；up=true 向上弹出，收缩栏在页面顶部须向下；
      alignRight=true 右对齐——收缩态 pill 在 ml-auto 右侧，默认左对齐会溢出屏幕右缘） */
  function renderSkillMenu(up: boolean, alignRight = false) {
    if (skillCount === 0) return null;
    return (
      <span className="relative" ref={skillAnchor}>
        <button
          type="button"
          onClick={() => {
            // 打开（向上弹）时按锚点上方空间重新限高
            if (up && !skillMenuOpen) setSkillMenuMaxH(upMaxH(skillAnchor.current));
            setSkillMenuOpen((v) => !v);
          }}
          title="展开该 agent 已启用的技能清单，点击一键使用"
          aria-expanded={skillMenuOpen}
          className="rounded-sm bg-inset px-1.5 py-0.5 text-l3 hover:bg-seg-sel hover:text-l1"
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
            {/* 技能清单：一键使用（运行中注入终端输入框，未启动写进首条指令）；
                高度随锚点上方空间收缩，防顶出屏幕 */}
            <ul
              style={{ maxHeight: up ? skillMenuMaxH : 224 }}
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} ${alignRight ? "right-0" : "left-0"} z-50 w-64 overflow-auto rounded-md border border-field ccode-float-surface p-1`}
            >
              {agentSkills.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useSkill(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    {s.description && (
                      <span className="truncate text-micro text-l4">
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
  function renderMcpMenu(up: boolean, alignRight = false) {
    if (agentMcps.length === 0) return null;
    return (
      <span className="relative" ref={mcpAnchor}>
        <button
          type="button"
          onClick={() => {
            if (up && !mcpMenuOpen) setMcpMenuMaxH(upMaxH(mcpAnchor.current));
            setMcpMenuOpen((v) => !v);
          }}
          title="该 agent 已分发的 MCP server 清单（MCP 页管理分发）"
          aria-expanded={mcpMenuOpen}
          className="rounded-sm bg-inset px-1.5 py-0.5 text-l3 hover:bg-seg-sel hover:text-l1"
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
              style={{ maxHeight: up ? mcpMenuMaxH : 224 }}
              className={`absolute ${up ? "bottom-full mb-1" : "top-full mt-1"} ${alignRight ? "right-0" : "left-0"} z-50 w-64 overflow-auto rounded-md border border-field ccode-float-surface p-1`}
            >
              {agentMcps.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => useMcp(s.name)}
                    className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{s.name}</span>
                    <span className="truncate font-mono text-micro text-l4">
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
                  className="flex w-full rounded-sm px-2 py-1.5 text-left text-micro text-l4 hover:bg-hover hover:text-l2"
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
  // 未启动时的目录编辑入口在底部状态栏 📂 浮层（启动前生效，与轮询不冲突）
  useEffect(() => {
    if (!visible || !activePtyId || (!running && !shellActive)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const real = await invoke<string | null>("pty_get_cwd", {
          ptyId: activePtyId,
        });
        if (!cancelled && real) {
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

  // 空态引导卡可见性（画布中央卡片 + 启动栏主按钮降级 + ⌘↵ 快捷键共用同一条件）
  const welcomeVisible = !shellOnly && !running && !shellActive;
  // 启动栏第二行（状态提示行）有内容才渲染——只有 ⋯ 时整行像悬空碎片（v3.92 修）
  const showBarMeta = !!(
    error ||
    cwdIssue ||
    (initialExtraEnv && Object.keys(initialExtraEnv).length > 0) ||
    (!running &&
      (shellActive || exited || restored))
  );
  // ⌘↵ 直启动作经 ref 转发（xterm 键盘层 handler 是挂载期闭包，只能经 ref 拿最新状态）
  const launchNowRef = useRef<() => void>(() => {});
  launchNowRef.current = () => {
    if (!profileId) return;
    if (restored) void restoreTask();
    else void launch();
  };
  const welcomeVisibleRef = useRef(welcomeVisible);
  welcomeVisibleRef.current = welcomeVisible;
  // ⌘/Ctrl+Enter 直接启动（打字中不抢；终端聚焦时按键被 xterm 吞掉、走不到 window，
  // 那条路径由 attachCustomKeyEventHandler 里的同款分支兜底——与 ⌘F 同一处理模式）
  useEffect(() => {
    if (!visible || !primaryFocus || !welcomeVisible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el) {
        const tag = el.tagName;
        const typing =
          (tag === "TEXTAREA" &&
            !el.classList.contains("xterm-helper-textarea")) ||
          tag === "INPUT" ||
          tag === "SELECT" ||
          el.isContentEditable;
        if (typing) return;
      }
      e.preventDefault();
      launchNowRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, primaryFocus, welcomeVisible]);
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
      startedAt,
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
    startedAt,
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

  // 恢复占位标签只做目录检查，不自动启动或偷偷迁移目录；失效时把修复入口放进空态卡。
  useEffect(() => {
    if (!restored || !visible || !everVisible) return;
    void checkWorkingDirectory(cwd);
  }, [restored, visible, everVisible, cwd]);

  useEffect(() => {
    if (!everVisible) return;
    const term = new Terminal({
      // Unicode11Addon 使用 xterm 的 proposed Unicode API；显式开启后才能在
      // xterm 6 中加载宽度规则，否则 addon.activate 会抛错并触发顶层错误边界。
      allowProposedApi: true,
      // 回退链补 Cascadia Mono（Win10+ 自带）与雅黑（CJK 兜底）——否则 Windows 上
      // JetBrains Mono 未装时中文落到通用 monospace 位图字体，发糊发虚
      fontFamily: `'${settingsRef.current?.terminalFontFamily ?? "JetBrains Mono"}', 'JetBrains Mono', 'SF Mono', Menlo, 'Cascadia Mono', Consolas, 'Microsoft YaHei', monospace`,
      fontSize: settingsRef.current?.terminalFontSize ?? 14,
      // 显示质感微调：清瘦锐利（向 Ghostty 靠）、盒绘对齐、粗体增亮、平滑滚动
      fontWeight: 400,
      fontWeightBold: 600,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: true,
      // 暗色 TUI 弱字（brightBlack 灰、dim 修饰）在深底上对比度过低发暗——
      // 按 VS Code 终端同款默认 4.5 兜底提亮（只抬对比度不足的颜色，不改调色板定义）
      minimumContrastRatio: 4.5,
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
    // Ghostty/现代终端使用 Unicode 11 宽度规则；xterm 默认 Unicode 6
    // 会让部分 emoji、组合字符和新 CJK 字符错列，尤其在 TUI 表格中明显。
    term.loadAddon(new Unicode11Addon());
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
      // kimi 的 TUI 开了 kitty 键盘协议（\x1b[>7u）后只认 CSI-u 形式的 Enter，
      // xterm.js 不支持该协议（手动回车发 \r，kimi 不提交）——在键盘层改写。
      // 仅拦无修饰的 Enter；Shift/Ctrl/Alt 组合键保持原样穿透
      if (
        agentId === "kimi" &&
        e.type === "keydown" &&
        e.key === "Enter" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const id = ptyIdRef.current;
        if (id)
          invoke("pty_write", { ptyId: id, data: "\x1b[13u" }).catch(() => {});
        return false;
      }
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "f"
      ) {
        setSearchOpen(true);
        return false;
      }
      // macOS 贴图键透传：七家 CLI（claude/codex/gemini/qwen/opencode/kimi/codebuddy）
      // 的剪贴板图片粘贴键是 Ctrl+V——CLI 收到按键后自己去读系统剪贴板；但网页侧
      // Ctrl+V 在 WKWebView 里不产生 paste 事件也不进 PTY，须在键盘层改写为 \x16。
      // 只拦 macOS：Windows 各家贴图用 Alt+V（本就透传为 ESC+v），
      // Windows/Linux 的 Ctrl+V 保留文本粘贴语义（走下方 paste 事件路径）。
      if (
        IS_MAC &&
        e.type === "keydown" &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "v"
      ) {
        const id = ptyIdRef.current;
        if (id) {
          // kimi 开了 kitty 键盘协议后只认 CSI-u（v=118 + ctrl 修饰位 5），
          // 与同函数上方 Enter → \x1b[13u 同一改写模式——待实机验证
          const data = agentId === "kimi" ? "\x1b[118;5u" : "\x16";
          invoke("pty_write", { ptyId: id, data }).catch(() => {});
        }
        return false;
      }
      // ⌘/Ctrl+Enter 空态直启：终端聚焦时按键到不了 window 监听，必须在 xterm 键盘层拦
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        e.key === "Enter" &&
        welcomeVisibleRef.current
      ) {
        launchNowRef.current();
        return false;
      }
      return true;
    });

    // 渲染器选择：macOS 不用 WebGL——xterm 的字形图集→GPU 纹理采样在 WKWebView 里
    // 整体偏软发糊（A/B 实测 DOM 渲染明显更锐利，Safari 同引擎复现一致）；
    // Windows 保留 WebGL 加速，但软件渲染（SwiftShader 等，闪烁）或上下文丢失时退回默认渲染器。
    try {
      if (!IS_MAC && !isSoftwareWebGL()) {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
        });
        term.loadAddon(webgl);
      }
    } catch {
      // GPU/驱动不支持时保持默认渲染器
    }

    // 链接可点击：点击经 opener 插件打开系统浏览器（不泄进 PTY，与技能页同源）
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openUrl(uri);
      }),
    );

    // 剪贴板图片粘贴：capture 阶段拦在 xterm 默认文本粘贴之前——
    // 有 image/* 条目就落盘并把绝对路径写进 PTY；无图片则不干预（走默认文本粘贴）
    const container = containerRef.current!;
    const onPasteCapture = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const idx = firstImageItem(items);
      if (idx < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const file = items[idx].getAsFile();
      if (file) void pasteImageFile(file);
    };
    container.addEventListener("paste", onPasteCapture, true);

    // 文件拖入转路径：只响应落在本终端 rect 内的 drop（人工事项导入等其它
    // 拖放监听按各自坐标域区分，互不拦截）；多路径 shell 转义后空格拼接，
    // 不换行——只进输入框，避免误执行
    const unlistenDrop = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return; // display:none 的隐藏标签 rect 全 0
      const scale = window.devicePixelRatio || 1;
      const { x, y } = event.payload.position;
      // Tauri 报物理像素 → CSS 像素换算；个别平台口径不一，两种都试（HumanTasksList 同款防御）
      const hit = [
        [x, y],
        [x / scale, y / scale],
      ].some(
        ([px, py]) =>
          px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom,
      );
      if (!hit) return;
      const paths = event.payload.paths;
      const text = joinDroppedPaths(paths);
      if (!text) return;
      const id = ptyIdRef.current;
      if (id) {
        invoke("pty_write", { ptyId: id, data: text })
          .then(() => flashInputNote(`已写入 ${paths.length} 个路径`))
          .catch(() => {});
      }
    });

    const onWinResize = () => {
      try {
        fit.fit();
      } catch {}
    };
    window.addEventListener("resize", onWinResize);

    // 容器尺寸变化的通用兜底：状态栏进出、启动栏塌缩、分屏拖拽、侧栏开合……
    // 凡改变 xterm 容器高度的都自动 fit，不再逐个点名触发（留空/遮行问题的根治）
    const resizeObs = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // display:none 时尺寸为 0，fit 会抛；可见性 effect 里会补
      }
    });
    if (containerRef.current) resizeObs.observe(containerRef.current);

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
      resizeObs.disconnect();
      container.removeEventListener("paste", onPasteCapture, true);
      void unlistenDrop.then((f) => f());
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

  // 空态隐藏 xterm 的静态块光标（左上角那个）：DECTCEM 转义对 WebGL/DOM 渲染都生效，
  // 不写进回滚缓冲；启动后进程输出会自行把光标恢复
  useEffect(() => {
    termRef.current?.write(welcomeVisible ? "\x1b[?25l" : "\x1b[?25h");
  }, [welcomeVisible, everVisible]);

  // 标签从隐藏切回可见 / 右侧面板开关改变可用宽度时重新 fit（display:none 下尺寸为 0）；
  // barExpanded 切换（启动时启动栏塌缩为收缩态）同样改变终端区高度，不补 fit 会下方留空
  useEffect(() => {
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
  }, [visible, rightOpen, layoutKey, barExpanded]);

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
    void (async () => {
      try {
        if (!(await checkWorkingDirectory(cwd))) return;
        autoStartedRef.current = true;
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
      void (restored ? restoreTask() : launch());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, everVisible, autoStart, profileId, profiles, restored]);

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
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return;
    }
    await cleanupPty();
    setLinkState("detecting");
    linkStartedAtRef.current = Date.now();
    // 步骤认领（「跟 AI 商量一下」）：spawn 前以最终 agent/cwd 登记——此刻的值才是用户
    // 在启动栏确认后的真实选择；会话归属由列表扫描命中后固化进 session_meta.step_name。
    // 同标签重复启动（重启 agent 接着聊任务书）重新登记，新会话仍归该步骤
    if (stepClaimName && !resumeId && !resumeSessionId) {
      invoke("claim_next_session_for_step", {
        agent: agentId,
        cwd,
        stepName: stepClaimName,
      }).catch(() => {
        // 登记失败静默降级：会话不归步骤，仍可在对话页全部列表里看到
      });
    }
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
        // 「聊想法」只读模式：后端按注册表注入只读/计划模式参数（不支持的 CLI 只有 prompt 软约束）
        readonly: readonly ?? null,
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
      setStartedAt(Date.now());
      if (res.promptDropped) {
        // 该 CLI 无交互注入参数（目前仅 kimi）：保留启动栏展开与指令文本，
        // 并自动复制到剪贴板（运行中输入框 disabled 不可选中），用户在终端里粘贴发送
        void navigator.clipboard.writeText(promptText).catch(() => {});
        setError("该 CLI 不支持启动注入：指令已复制，请在终端里粘贴发送");
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
    if (!(await checkWorkingDirectory(cwd))) {
      setBarExpanded(true);
      return;
    }
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
    if (!(await checkWorkingDirectory(cwd))) {
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
    logLine: () => {},
    setCwd: () => {},
    chooseCwd: () => {},
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
    // 暗淡色（SGR 2）写一行，不进 PTY 输入流
    logLine: (text) => termRef.current?.writeln(`\x1b[2m${text}\x1b[0m`),
    setCwd: (c) => setWorkingDirectory(c),
    chooseCwd: () => void chooseWorkingDirectory(),
  };
  useEffect(() => {
    onActions?.(tabId, {
      stop: () => actionsRef.current.stop(),
      resume: () => actionsRef.current.resume(),
      openConversationPage: () =>
        actionsRef.current.openConversationPage(),
      search: () => actionsRef.current.search(),
      modify: () => actionsRef.current.modify(),
      logLine: (t) => actionsRef.current.logLine(t),
      setCwd: (c) => actionsRef.current.setCwd(c),
      chooseCwd: () => actionsRef.current.chooseCwd(),
    });
  }, [onActions, tabId]);

  // P1b：启动栏输入框统一 inset 底（浮起层级），聚焦边线不变
  const select =
    "h-8 rounded-md border border-field bg-inset px-2 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4";
  // 分段容器内的无边框控件（v3.92：Agent/配置/模型三组收进同一条分段工具条，
  // 段与段之间留真空隙（gap）各自成小胶囊、不靠分隔线粘连，hover 单段高亮）
  const seg =
    "h-7 rounded-sm bg-transparent px-2 text-sm text-l2 outline-none placeholder:text-l4 hover:bg-hover focus:bg-hover disabled:hover:bg-transparent";

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
          {
            label: "◈ 提炼接力…",
            onSelect: () =>
              onDigest?.({
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
    {
      label: advancedLaunchOpen ? "收起高级启动选项" : "显示高级启动选项",
      onSelect: () => setAdvancedLaunchOpen((v) => !v),
    },
    // 「快速开聊」的转正出口：把当前目录登记成项目，会话历史天然跟 cwd 走、
    // 自动归到新项目下（ProjectAggregator 既有归并口径，不需要迁移任何东西）。
    // 只登记，不建工作区、不选模板——模板从项目页的引导横幅或 ⋯ 里选。
    {
      label: "转为项目…",
      onSelect: () => {
        void (async () => {
          const dir = cwd.trim().replace(/[\\/]+$/, "");
          const name = dir.split(/[\\/]/).pop() || dir;
          if (!dir) return;
          if (
            !(await confirmDialog(
              `把「${dir}」登记为 Ccode 项目？\n只登记这个目录，不会建工作区、不改动任何文件；登记后可在项目页选研究流程模板。`,
              { confirmText: "登记" },
            ))
          )
            return;
          try {
            await invoke("register_project", { path: dir, name });
            useAppStore.getState().setSelectProjectReq(dir);
            useAppStore.getState().setPage("workspaces");
          } catch (e) {
            void alertDialog(`转为项目失败：${String(e)}`);
          }
        })();
      },
    },
    { label: "◎ 查找终端输出", onSelect: () => setSearchOpen(true) },
  ];

  // 终端画布右键菜单：复制按打开菜单那一刻的选区裁剪（setTermCtxMenu 触发重渲染即取到最新值）
  const ctxSelection = termRef.current?.getSelection() ?? "";
  const termCtxMenuItems = [
    {
      label: "复制",
      disabled: !ctxSelection,
      title: ctxSelection ? undefined : "先在终端里选中一段输出",
      onSelect: () =>
        void navigator.clipboard.writeText(ctxSelection).catch(() => {}),
    },
    { label: "粘贴", onSelect: () => void pasteFromClipboard() },
    { label: "全选", onSelect: () => termRef.current?.selectAll() },
    { label: "清屏", onSelect: () => termRef.current?.clear() },
    { label: "查找输出", onSelect: () => setSearchOpen(true) },
  ];

  return (
    <div className="flex h-full flex-col px-2 pt-1">
      {barExpanded ? (
        <>
          <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
            {/* Agent/配置/模型收进同一条分段工具条（v3.92）：去掉三个独立框线；
                段间留空隙（容器 gap + 内边距）各自成小胶囊，不粘在一起。
                v3.93：段间加 h-4 短竖线（不贯穿整行，居中一小段）强化三段的分组边界 */}
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-field bg-inset p-0.5">
            <select
              className={`${seg} w-36 shrink-0`}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setProfileId("");
                setModel("");
                setModelKept(false);
              }}
              disabled={running}
            >
              {AGENTS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-field" />
            <select
              ref={profileSelectRef}
              className={`${seg} w-40 shrink-0`}
              value={profileId}
              onChange={(e) => {
                const prevModels =
                  profiles.find((p) => p.id === profileId)?.models ?? [];
                const prof = profiles.find((p) => p.id === e.target.value);
                setProfileId(e.target.value);
                // 手填的模型不再被静默清掉（v3.88）：不在新配置模型表里就保留，
                // 并由下方说明行告知「仍会按原样注入」
                const next = modelOnProfileSwitch(
                  model,
                  prevModels,
                  prof?.models ?? [],
                );
                setModel(next.model);
                setModelKept(next.kept);
              }}
              disabled={running}
            >
              <option value="" disabled>
                选择配置
              </option>
              {profileId && !selectedProfile && (
                <option value={profileId}>上次配置已不存在</option>
              )}
              {/* 「隐藏此配置」的落点（v3.88）：隐藏项沉到「更多」optgroup，不从列表里消失
                  ——真删掉会让已选中它的标签无从显示。配置本身与启动行为一字未改 */}
              {agentProfiles
                .filter((p) => !hiddenProfiles.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              {agentProfiles.some((p) => hiddenProfiles.includes(p.id)) && (
                <optgroup label="更多（已隐藏）">
                  {agentProfiles
                    .filter((p) => hiddenProfiles.includes(p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
            {selectedProfile && (
              // 模型 combo-box：可输可选（profile 预设 + 本 agent 历史），输入即筛选，
              // 自由输入的模型启动成功后记入历史（ccode.modelHistory.<agent>），下次直接可选
              <>
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-field" />
              <span className="relative w-56 shrink-0">
                <input
                  className={`${seg} w-full`}
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setModelKept(false);
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
                  <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border border-field ccode-float-surface py-1">
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
                              setModelKept(false);
                              setModelOpen(false);
                            }}
                            className="flex w-full truncate px-2 py-1 text-left text-xs text-l2 hover:bg-hover hover:text-l1"
                          >
                            {m}
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </span>
              </>
            )}
            </div>
            {/* 目录由底部状态栏 📂 胶囊编辑（仅未启动）；主栏保持 Agent → 配置 → 模型 → 启动。 */}
            {/* run 脚本（shellOnly）标签不走 agent 启动流程：隐藏启动/停止按钮，
                避免误点「启动」无确认杀掉正在跑的脚本 shell */}
            {!shellOnly &&
              (running ? (
                <button
                  onClick={stop}
                  className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-field bg-inset px-3 text-sm text-err-text hover:bg-hover"
                >
                  停止
                </button>
              ) : (
                /* 空态卡片在场时降级为线框——同一视野内只留卡片里一个高亮主按钮（v3.91） */
                <button
                  onClick={() => (restored ? void restoreTask() : void launch())}
                  disabled={!profileId}
                  className={`inline-flex h-8 shrink-0 items-center justify-center rounded-md border px-3 text-sm disabled:opacity-50 ${
                    welcomeVisible
                      ? "border-field bg-inset text-l2 hover:bg-hover"
                      : "border-cta-bd bg-cta text-cta-text hover:brightness-110"
                  }`}
                >
                  {restored ? "恢复任务" : "运行"}
                </button>
              ))}
            <button
              type="button"
              onClick={openTerminalActionMenu}
              title="更多终端操作"
              aria-label="更多终端操作"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm text-l3 hover:bg-hover hover:text-l1"
            >
              ⋯
            </button>
            {/* 模型相关的「为什么没生效」就近说清（v3.88）：
                以前这些只写在配置页表单与用户手册里，用户在启动栏换模型没反应时看不到任何解释 */}
            {(() => {
              const prof = profiles.find((p) => p.id === profileId);
              const cap = launchModelNote(agentId, prof?.models.length ?? 0);
              const emptyModels =
                !!prof && prof.models.length === 0 && !model.trim();
              const odd = model.trim() !== "" && !looksLikeModelId(model);
              const line = modelKept
                ? "不在这个配置的模型列表里，仍按原样用。"
                : emptyModels
                  ? "这个配置没填模型，会用 CLI 自己的默认值。"
                  : odd
                    ? "这串不太像模型名，确认一下。"
                    : cap;
              return line ? (
                <span
                  className={`w-full text-micro leading-4 ${
                    modelKept || emptyModels || odd ? "text-warn-text" : "text-l4"
                  }`}
                >
                  {line}
                </span>
              ) : null;
            })()}
          </div>
          {advancedLaunchOpen || showPrompt ? (
            <div className="mb-2 rounded-md bg-strip px-2.5 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 text-xs text-l3">高级启动选项</span>
                {renderSkillMenu(false)}
                {renderMcpMenu(false)}
                {!showPrompt && !shellOnly && (
                  <button
                    type="button"
                    className="ml-auto h-7 rounded-sm px-2 text-micro text-l4 hover:bg-hover hover:text-l2"
                    onClick={() => setShowPrompt(true)}
                  >
                    添加首条指令
                  </button>
                )}
              </div>
              {/* 一键开步的首条指令：可编辑，留空 = 不注入；注入成功即清除。 */}
              {showPrompt && !shellOnly && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 text-xs text-l3">启动后自动发送：</span>
                  <input
                    className={`${select} min-w-0 flex-1 py-1 text-xs`}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    placeholder="留空则不注入首条指令"
                    disabled={running}
                  />
                  {running && promptText.trim() && (
                    <button
                      type="button"
                      title="复制指令到剪贴板"
                      onClick={() =>
                        void navigator.clipboard.writeText(promptText).catch(() => {})
                      }
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
                    >
                      ⧉
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : null}
          {/* 第二行（状态提示行）有内容才渲染；⋯ 已挪到第一行末尾（v3.92） */}
          {showBarMeta && (
          <div className="mb-2 flex min-h-7 flex-wrap items-center gap-2 border-t border-hairline pt-1 text-xs">
            {initialExtraEnv && Object.keys(initialExtraEnv).length > 0 && (
              <span
                className="text-l4"
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
              <span className="text-l3">上次任务，可恢复</span>
            )}
            {cwdIssue && (
              <span className="truncate text-warn-text" title={cwdIssue}>
                {directoryUnavailableMessage(cwdIssue)}
              </span>
            )}
            {error && <span className="truncate text-err-text">{error}</span>}
          </div>
          )}
          {/* 无配置的引导统一收进空态卡片（v3.92：卡片给「去配置页创建」动作；
              不再在启动栏里渲染整段 EmptyState——那条 min-h-48 灰带与卡片重复且视觉断裂） */}
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
            {/* 高级启动项不在收缩态常驻；从标签栏 ⋯ → 修改启动配置后，在高级启动选项中访问。 */}
            <button
              type="button"
              onClick={() => setBarExpanded(true)}
              title="修改启动配置"
              className="rounded-sm px-2 py-1 text-l3 hover:bg-hover hover:text-l1"
            >
              修改
            </button>
            <button
              type="button"
              onClick={openTerminalActionMenu}
              title="更多终端操作"
              aria-label="更多终端操作"
              className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
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
            className="w-56 rounded-sm border border-field bg-inset px-2 py-1 text-sm text-l2 outline-none placeholder:text-l4 focus:border-l4"
          />
          <button
            onClick={findPrev}
            title="上一个（Shift+Enter）"
            className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
          >
            ↑
          </button>
          <button
            onClick={() => findNext()}
            title="下一个（Enter）"
            className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
          >
            ↓
          </button>
          <button
            onClick={closeSearch}
            title="关闭（Esc）"
            className="flex h-7 w-7 items-center justify-center rounded-sm text-sm text-l3 hover:bg-hover hover:text-l1"
          >
            ×
          </button>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={containerRef}
          // 阅读区打开期间由 TerminalPage 按此标记把本节点搬进覆盖层右栏（DOM 搬移不重建）
          data-terminal-host={tabId}
          className="min-w-0 flex-1 overflow-hidden px-3 py-2.5"
          onContextMenu={(e) => {
            e.preventDefault();
            setTermCtxMenu({ x: e.clientX, y: e.clientY });
          }}
        />
        {/* 粘贴图片/拖入文件的瞬态轻反馈（不挡画布，3s 自消） */}
        {inputNote && (
          <div className="pointer-events-none absolute bottom-3 right-4 z-20 max-w-[80%] truncate rounded-sm border border-field ccode-float-surface px-2 py-1 text-xs text-l2">
            {inputNote}
          </div>
        )}
        {/* 未启动空态引导（v3.91）：画布中央一张极简卡片，说清「现在该干嘛」。
            xterm 保持挂载在底层（移树会杀 PTY 语义）；浮层壳 pointer-events-none 不挡画布 */}
        {welcomeVisible && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            {/* 玻璃拟态卡：raised 85% + backdrop-blur（画布内容隐约透出）。
                勾边（v3.93 微调）：l1 的 12% 混合——field 档在浅色主题偏蓝显脏，
                hairline 档又太弱，取两者之间的极浅中性边。
                元素收敛（v3.93 用户拍板）：不要顶部图标盒、不要说明小字（「上次任务还在」
                这类——按钮文案「恢复任务/启动/去配置页创建」本身已说清现在该干嘛），
                卡片 w-80（v3.93 二调：w-72 太挤，主按钮被按比例压缩到快溢出——
                按钮宽改 min-w-40 自适应内容，不再随卡片宽比例缩放）；
                agent 名与配置胶囊是这张卡的主体信息，字号放大 */}
            <div
              className="pointer-events-auto relative flex w-80 flex-col items-center gap-3 rounded-lg border bg-raised/85 px-5 py-5 text-center shadow-lg backdrop-blur-xl"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--color-l1) 12%, transparent)",
              }}
            >
              {cwdIssue && (
                <div className="w-full rounded-md border border-field bg-inset px-3 py-2 text-left text-xs">
                  <div className="font-medium text-warn-text">工作目录不可用</div>
                  <div className="mt-1 truncate font-mono text-micro text-l3" title={cwdIssue}>
                    {cwdIssue}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => void chooseWorkingDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm border border-cta-bd bg-cta px-2 py-1 text-micro text-cta-text disabled:opacity-50"
                    >
                      选择新目录
                    </button>
                    <button
                      type="button"
                      onClick={() => void returnToHomeDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm border border-field bg-inset px-2 py-1 text-micro text-l2 disabled:opacity-50"
                    >
                      回到主目录
                    </button>
                    <button
                      type="button"
                      onClick={() => void checkWorkingDirectory()}
                      disabled={cwdChecking}
                      className="rounded-sm px-2 py-1 text-micro text-l3 hover:bg-hover disabled:opacity-50"
                    >
                      {cwdChecking ? "检查中…" : "重新检查"}
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 text-base font-medium text-l1">
                {agentLabel(agentId)}
                {selectedProfile && (
                  <span className="rounded-sm bg-inset px-1.5 py-0.5 text-xs font-normal text-l2">
                    {selectedProfile.name}
                  </span>
                )}
              </div>
              {agentProfiles.length === 0 ? (
                /* 无配置时主按钮换成有效引导（禁用的「启动」是死按钮，v3.92 修） */
                <button
                  type="button"
                  onClick={() => setPage("profiles")}
                  className="inline-flex h-9 min-w-40 cursor-pointer items-center justify-center rounded-md border border-cta-bd bg-cta px-5 text-sm text-cta-text hover:brightness-110"
                >
                  去配置页创建
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      restored ? void restoreTask() : void launch()
                    }
                    disabled={!profileId || cwdChecking}
                    className="inline-flex h-9 min-w-40 cursor-pointer items-center justify-center gap-2 rounded-md border border-cta-bd bg-cta px-5 text-sm text-cta-text hover:brightness-110 disabled:cursor-default disabled:opacity-50"
                  >
                    {restored ? "恢复任务" : "运行"}
                    {/* 快捷键说明：括号小字随按钮文字整体居中，不加胶囊底色
                        （18% 混合底在纯色按钮上是块显眼补丁，用户否为「色差」）；勿绝对定位钉右缘 */}
                    <span className="text-micro opacity-80">
                      （{IS_MAC ? "⌘ + Enter" : "Ctrl + Enter"}）
                    </span>
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void openShell()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-field bg-inset px-3 py-1.5 text-xs text-l3 transition-colors hover:border-l4 hover:bg-hover hover:text-l1 active:brightness-95"
              >
                <span aria-hidden="true" className="font-mono">
                  &gt;_
                </span>
                打开普通 Shell 终端
              </button>
            </div>
          </div>
        )}
      </div>
      {terminalActionMenu && (
        <ContextMenu
          x={terminalActionMenu.x}
          y={terminalActionMenu.y}
          onClose={() => setTerminalActionMenu(null)}
          items={terminalMenuItems}
        />
      )}
      {termCtxMenu && (
        <ContextMenu
          x={termCtxMenu.x}
          y={termCtxMenu.y}
          onClose={() => setTermCtxMenu(null)}
          items={termCtxMenuItems}
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
  /** 「聊想法」只读模式标签：pty_spawn 注入只读/计划模式参数（不进持久化白名单） */
  readonly?: boolean;
  /** 应用重启后恢复出的元数据占位标签。 */
  restored?: boolean;
  /** 复用键（pendingTerminal.reuseKey 透传）：同 key 的重复开聊请求切换到本标签。
      仅内存标记，不进重启持久化白名单（恢复出的占位标签不参与复用——会话已断，新开更诚实） */
  reuseKey?: string;
  /** 步骤认领（pendingTerminal.stepName 透传）：launch 时以最终 agent/cwd 登记，
      让该标签产出的会话归到该步骤。仅内存标记，不进重启持久化白名单 */
  stepName?: string;
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
  // 标签条拖拽排序（Ghostty 式跟手拖动）：源标签随指针平移、其余标签滑动让位（150ms
  // transition）、松手先吸附到目标槽位再真正重排——全程无 HTML5 DnD（Tauri 原生文件拖放
  // dragDropEnabled 默认开，会拦截 WKWebView 拖拽手势，dragstart 根本不触发）。
  // 拖拽期间 tabs 顺序不变（布局稳定，槽位测量值才有效），落定时才 moveTab 重排；
  // 顺序即 tabs 数组顺序，重启持久化按数组存，重排自动带过去
  const [tabDrag, setTabDrag] = useState<{
    id: string;
    /** 源标签原索引（= 当前渲染索引，拖拽期间顺序不变） */
    from: number;
    /** 指针当前落在的槽位索引（让位动画与落定位置都按它） */
    target: number;
    /** 源标签当前位移 px（钳制在标签条内容范围内） */
    dx: number;
    /** 拖拽开始时各槽位测量值（viewport 坐标；顺序 = tabs 顺序） */
    rects: { left: number; width: number }[];
    /** true = 松手吸附动画中：源标签 transition 到落点，结束才重排清态 */
    settling: boolean;
  } | null>(null);
  // 拖拽落定后的那次 click 要吞掉（否则拖完还会触发激活切换）
  const suppressTabClickRef = useRef(false);
  const moveTab = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from < 0 || to < 0 || from >= prev.length || to >= prev.length || from === to)
        return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);
  /** 标签按下即挂 window 级 move/up 监听：横向位移超 6px 才进入拖拽，否则当普通点击放过 */
  function onTabPointerDown(e: React.PointerEvent, tabId: string) {
    if (e.button !== 0) return;
    const tabEl = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    let active = false;
    let rects: { left: number; width: number }[] = [];
    let from = 0;
    // finish 里要用最新 target（setState 闭包拿不到），ref 镜像
    let lastTarget = 0;
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = "";
    };
    const finish = () => {
      cleanup();
      if (!active) return;
      suppressTabClickRef.current = true;
      const target = lastTarget;
      if (target === from) {
        setTabDrag(null);
        return;
      }
      // 先吸附：源标签 transition 滑到目标槽位，动画结束才重排（与 transition 时长对齐）
      setTabDrag((cur) =>
        cur
          ? {
              ...cur,
              dx: cur.rects[target].left - cur.rects[from].left,
              settling: true,
            }
          : null,
      );
      window.setTimeout(() => {
        moveTab(from, target);
        setTabDrag(null);
      }, 170);
    };
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - startX) <= 6) return;
        active = true;
        // 进入拖拽态才测量槽位（此刻布局未变）；querySelectorAll 顺序 = tabs 顺序
        const els = Array.from(
          (tabEl.parentElement ?? tabEl).querySelectorAll<HTMLElement>(
            "[data-tab-id]",
          ),
        );
        rects = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, width: r.width };
        });
        from = Math.max(
          0,
          els.findIndex((el) => el.getAttribute("data-tab-id") === tabId),
        );
        lastTarget = from;
        // 拖动经过的标签标题会被划选，拖拽期间全局禁选
        document.body.style.userSelect = "none";
      }
      // 钳制：源标签不出标签条内容范围；目标槽位：源中心越过谁的中线就占谁的位
      // （纯逻辑在 tab-drag.ts——>= 判定守「拖到最右」边界，曾翻车：严格 > 永远够不到末槽）
      const dx = clampTabDragDx(rects, from, ev.clientX - startX);
      const target = tabDragTarget(rects, from, dx);
      lastTarget = target;
      setTabDrag({ id: tabId, from, target, dx, rects, settling: false });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }
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
  // 右侧成果工作台默认可见；对话、文件、改动在同一处切换，避免入口散落在终端标签内。
  const [rightOpen, setRightOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    const width =
      Number.isFinite(saved) && saved > 0 ? saved : RIGHT_PANEL_DEFAULT_WIDTH;
    // 上限由挂载时的窗口尺寸动态钳制（见下方 resize 副作用），这里只保下限
    return Math.max(RIGHT_PANEL_MIN_WIDTH, width);
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
  // 「◈ 提炼接力…」目标选择器：AI 蒸馏全会话简报，三路径续作
  const [digestSource, setDigestSource] = useState<HandoffSource | null>(null);

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
            {
              label: "◈ 提炼接力…",
              onSelect: () =>
                setDigestSource({
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
  const [gitTotals, setGitTotals] = useState<GitSummary | null>(null);
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
  /** 沉浸式阅读区（批次 B1）：非空即全屏覆盖（z-40 页面模态档），底下终端/右栏保持挂载；
      notePath 指定后笔记栏直接编辑该 md（精读笔记产物入口），不按 PDF slug 另建档 */
  const [reader, setReader] = useState<{
    pdfPath: string;
    projectRoot: string;
    notePath?: string;
  } | null>(null);
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
  /** 左栏文件树当前根（钻取/切根后与 activeCwd 分叉）：改动面板跟随它而不是终端标签 cwd，
      未分叉时为 null 回落 activeCwd（v3.82 口径：「我在看哪个目录，改动就显示哪个」） */
  const [treeRoot, setTreeRoot] = useState<string | null>(null);
  const gitPanelCwd = treeRoot ?? activeCwd;
  // 切标签/分屏焦点变化时回到新标签 cwd：树若未挂载（专注终端）就没人发 onRootNavigated，
  // 必须在这里清掉分叉，否则改动面板会停在旧标签的目录上
  useEffect(() => {
    setTreeRoot(null);
  }, [activeCwd]);

  /** 标签激活：分屏时点到右 pane 的标签则左右互换（活跃标签始终固定在左 pane） */
  function activateTab(id: string) {
    if (splitActive && id === splitTabId) setSplitTabId(activeId);
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
      total - railWidth - TERMINAL_MIN_RESERVE,
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
      // 沉浸阅读区在更外层：打开期间 Esc 先退阅读区（它自己的监听处理）
      if (reader) return;
      if (focusMode) setFocusMode(false);
      if (rightExpanded) toggleRightExpanded();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode, rightExpanded, reader]);

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

  /** GitPanel 上报改动摘要（页签 +N 徽标与标签条变更芯片共用）；内容没变就不更新（按签名比较，免 8s 轮询空转重渲染） */
  const reportGitTotals = useCallback((t: GitSummary) => {
    const sig = (s: GitSummary) =>
      `${s.add}|${s.del}|${s.isRepo}|${s.branch}|${s.ahead}|${s.behind}|${s.inWorkspace}|${s.files.map((f) => f.status + f.path).join(",")}`;
    setGitTotals((prev) => (prev && sig(prev) === sig(t) ? prev : t));
  }, []);

  /** FileTree 的 fs-changed 事件 → GitPanel 一并刷新（稳定回调） */
  const bumpFsChangeTick = useCallback(() => setFsChangeTick((t) => t + 1), []);

  /** 状态栏「Commit & Push」第一步：AI 生成提交信息（失败回落本地默认规则）。
      style = 分割菜单的风格偏好（空串 = 默认） */
  async function generateCommitMsg(style: string): Promise<string> {
    const s = gitTotals;
    if (!s?.isRepo || s.files.length === 0) throw new Error("没有可提交的改动");
    const paths = s.inWorkspace ? null : s.files.map((f) => f.path);
    return invoke<string>("ai_commit_message", {
      cwd: gitPanelCwd,
      paths,
      style: style || null,
    }).catch(() => defaultCommitMessage(s.files));
  }

  /** 状态栏「Commit & Push」第二步：以确认的信息全量提交并推送，
      返回结果（hash 给「✓ Pushed [a1b2c3d]」用）。与改动面板同一个 git_commit 命令 */
  async function commitPushMsg(message: string): Promise<GitCommitResultDto> {
    const s = gitTotals;
    if (!s?.isRepo) throw new Error("不是 git 仓库");
    const paths = s.inWorkspace ? null : s.files.map((f) => f.path);
    const res = await invoke<GitCommitResultDto>("git_commit", {
      cwd: gitPanelCwd,
      message,
      push: true,
      paths,
    });
    bumpFsChangeTick();
    return res;
  }

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

  /** 写入指定终端标签 agent 输入的核心链路（pty_write；send=true 时末尾补 \r 直接发送，
      缺省不自动回车、用户检查后发送）。右栏选段（活跃标签）与阅读区（阅读会话标签）共用；
      返回 null 表示已写入，返回字符串为要展示给用户的提示。 */
  const injectToTab = useCallback(
    (tabId: string, data: string, send?: boolean): string | null => {
      const s = statuses[tabId];
      if (!s?.running || !s.ptyId) {
        return "当前标签没有运行中的 Agent，请先启动再试";
      }
      invoke("pty_write", {
        ptyId: s.ptyId,
        data: send ? `${data}\r` : data,
      }).catch(() => {});
      return null;
    },
    [statuses],
  );

  /** 写入当前活跃终端标签 agent 输入（PDF 问 AI 与 md 讨论/改写共用） */
  const injectToActiveAgent = useCallback(
    (data: string, send?: boolean): string | null =>
      injectToTab(focusedId, data, send),
    [injectToTab, focusedId],
  );

  /** PDF 选段「◈ 问 AI」：选段 + 出处格式化后注入活跃终端（格式单一出处在 reader.ts，阅读区共用） */
  const askAiFromPdf = useCallback(
    (text: string, page: number, fileName: string, send?: boolean): string | null => {
      return injectToActiveAgent(formatPdfExcerptPrompt(text, page, fileName), send);
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
  // 会话底条 token 用量：与状态栏同一个 session_usage 命令、60s 轮询；无关联会话不查
  const [footerUsage, setFooterUsage] = useState<SessionUsageDto | null>(null);
  const footerSessionId = activeSession?.sessionId ?? null;
  const footerAgent = activeSession?.agentId ?? null;
  useEffect(() => {
    if (!footerSessionId || !footerAgent || rightTab !== "dialogue") {
      setFooterUsage(null);
      return;
    }
    let stale = false;
    const pull = () => {
      invoke<SessionUsageDto>("session_usage", {
        agent: footerAgent,
        sessionId: footerSessionId,
      })
        .then((u) => {
          if (!stale) setFooterUsage(u);
        })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      stale = true;
      clearInterval(t);
    };
  }, [footerSessionId, footerAgent, rightTab]);
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
      /** 「聊想法」只读模式：pty_spawn 透传，支持的 CLI 注入只读/计划模式参数 */
      readonly?: boolean;
      /** 复用键（pendingTerminal.reuseKey 透传）：重复入口切标签而不是新开 */
      reuseKey?: string;
      /** 步骤认领（pendingTerminal.stepName 透传）：launch 时登记会话归步骤 */
      stepName?: string;
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
        readonly: init?.readonly,
        reuseKey: init?.reuseKey,
        stepName: init?.stepName,
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

  // 从其他页面进入终端页：右栏默认收起，只剩终端——「默认可见」会在每次
  // 切回来时摊开一个此刻没用途的面板。只有明确交接才开：预览请求（资源面板
  // 「查看」）、pendingTerminal 指定右栏页签/预览（「主仓改动」提醒、开聊带开草稿）。
  // 必须声明在下方交接消费 effect 之前：交接与切页是同一批 store 更新，
  // 消费 effect 会立刻把 pendingTerminal/previewReq 置空——本 effect 用 getState 现查，
  // 顺序反了会把刚按交接打开的预览面板又收掉（「跟 AI 商量一下」带开 TASK.md 曾被这样关掉）。
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const was = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible || was) return;
    const st = useAppStore.getState();
    const handoff =
      st.previewReq !== null ||
      st.pendingTerminal?.rightTab != null ||
      st.pendingTerminal?.previewPath != null;
    if (!handoff) setRightOpen(false);
  }, [visible]);

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
  // 状态栏的模型/思考档槽位来自检测缓存（agents.rs DetectResult 随规格下发）
  const agents = useAppStore((s) => s.agents);
  // 状态栏配色与终端画面同底同色（buildXtermTheme 与 xterm 实例同一出处）
  const appSettings = useAppStore((s) => s.settings);
  const statusBarColors = (() => {
    const t = buildXtermTheme(
      appSettings?.theme ?? "midnight",
      appSettings?.terminalPalette,
    );
    return {
      background: t.background,
      foreground: t.foreground,
      green: t.green,
      red: t.red,
      yellow: t.yellow,
      blue: t.blue,
    };
  })();
  useEffect(() => {
    if (visible && pendingTerminal) {
      setPendingTerminal(null);
      // 显式打开另一任务的终端时，不让上一次任务审阅继续盖住新标签。
      setReviewPath(null);
      const pt = pendingTerminal;
      // 会话恢复：profile 依次 autoLaunchProfileId → ccode.lastProfile → 该 agent 首个配置；
      // codex 内联 provider 会话（rollout 记 model_provider="ccode"）只在带 Base URL 的
      // 配置里挑——否则 -c 定义不注入，codex 报 "Model provider `ccode` not found"
      // （兼容规则单一出处：resume-profile.ts pickResumeProfile）
      const agentId = pt.agentId ?? pt.resume?.agentId;
      let profileId = pt.profileId;
      let model = pt.model;
      if (pt.resume) {
        const wished =
          pt.autoLaunchProfileId ??
          localStorage.getItem(`ccode.lastProfile.${pt.resume.agentId}`);
        const pick = pickResumeProfile(
          profiles,
          pt.resume.agentId,
          pt.resume.provider,
          wished,
        );
        profileId = pick?.id ?? "";
        model = pick?.models[0] ?? "";
      }
      // 复用键：已有同 key 标签就切过去，不再新开（「快速开聊」「跟 AI 商量一下」等
      // 重复入口防标签堆积；恢复出的占位标签不带 reuseKey，不参与复用——会话已断，新开才诚实）。
      // 复用时不跳过右侧收尾：previewPath/rightTab 等交接对复用标签同样生效（重进即回到该有的布局）
      let tabId: string | null = null;
      if (pt.reuseKey) {
        const existing = tabs.find((t) => t.reuseKey === pt.reuseKey);
        if (existing) {
          tabId = existing.id;
          setActiveId(existing.id);
        }
      }
      // resume 兜底：reuseKey 没命中（restored/手动开的标签不带 key）时，若某活标签的 cwd
      // 就是目标目录，聚焦它而不是新开 resume——那个会话正被它的 CLI 进程持有，
      // 再 resume 会被拒（codex: thread already has an active writer）
      if (!tabId && pt.resume) {
        const norm = (p: string) => p.replace(/[\\/]+$/, "");
        const holder = tabs.find(
          (t) =>
            statuses[t.id]?.alive &&
            norm(statuses[t.id]?.cwd ?? t.initialCwd ?? "") === norm(pt.cwd),
        );
        if (holder) {
          tabId = holder.id;
          setActiveId(holder.id);
        }
      }
      tabId ??= addTab({
        cwd: pt.cwd,
        extraEnv: pt.extraEnv,
        title: pt.title,
        agentId,
        profileId,
        model,
        resumeSessionId: pt.resume?.sessionId,
        autoStart: !!pt.resume || !!pt.autoStart,
        prefillCommand: pt.prefillCommand,
        shellOnly: pt.shellOnly,
        initialPrompt: pt.initialPrompt,
        readonly: pt.readonly,
        reuseKey: pt.reuseKey,
        stepName: pt.stepName,
      });
      // run 脚本标签：登记 nonconcurrent 互斥追踪
      if (pt.wsId && tabId) setRunningScript(pt.wsId, tabId);
      // 「快速开聊」：落到最干净的终端——收起工作树与右栏，只剩标签条 + 终端。
      // 复用既有的「专注终端」语义（Esc 或 ⤢ 退出），不另造一套显隐状态。
      // 理由：随手聊没有项目上下文——文件树是空目录、改动面板是「不是 git 仓库」、
      // 对话面板要等会话关联，三个面板都没东西可给，摆着只是噪音
      if (pt.clean) {
        setFocusMode(true);
        setRightOpen(false);
      }
      // 指定右栏页签（如「主仓改动」提醒 → 改动面板）
      if (pt.rightTab === "git") {
        setRightOpen(true);
        setRightTab("git");
      }
      // 开聊自动带开文件预览（一次性交接，不落盘）：右栏落到预览页签，
      // 评审覆盖层已在上面统一关掉（同 previewReq 消费语义）
      if (pt.previewPath) {
        setRightOpen(true);
        setRightTab("preview");
        setPreview({
          path: pt.previewPath,
          name: basename(pt.previewPath),
          root: pt.previewRoot ?? null,
        });
        setPreviewDirty(false);
      }
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

  // ===== 沉浸式阅读区（批次 B1）=====
  // store 一次性请求消费（雷达卡「开读」等跨页入口）；终端页内部入口（预览工具条/文件树右键）直接 setReader
  const readerReq = useAppStore((s) => s.readerReq);
  const setReaderReq = useAppStore((s) => s.setReaderReq);
  useEffect(() => {
    if (!visible || !readerReq) return;
    setReaderReq(null);
    // 评审覆盖层会挡住阅读区，先关掉（同 previewReq 消费语义）；
    // 右栏若正在预览同一 PDF 保持原样不动它
    setReviewPath(null);
    setReviewAction(null);
    setReader({
      pdfPath: readerReq.pdfPath,
      projectRoot: readerReq.projectRoot,
      notePath: readerReq.notePath,
    });
  }, [visible, readerReq, setReaderReq]);

  const readerKey = reader ? readerReuseKey(reader.projectRoot) : null;
  /** 阅读会话标签（reuseKey 找回：退出再进接着聊；恢复出的占位标签不带 reuseKey 不参与复用） */
  const readerTabId = readerKey
    ? (tabs.find((t) => t.reuseKey === readerKey)?.id ?? null)
    : null;
  const [readerNeedsProfile, setReaderNeedsProfile] = useState(false);
  /** 自动起会话的一次性标记：用户手动关掉阅读会话标签后不连环重建（栏内给「重新启动」入口） */
  const readerTriedRef = useRef<string | null>(null);
  const [readerAgentTick, setReaderAgentTick] = useState(0);
  useEffect(() => {
    if (!reader) readerTriedRef.current = null;
  }, [reader]);

  /** 阅读会话的启动配置：agent 跟随启动栏上次选择；profile 按既有解析顺序
      （显式默认 settings.defaultProfiles > 上次使用 > 首个可见 > 首个，与启动栏一致） */
  function resolveReaderLaunch(): { agentId: string; profileId: string } {
    const st = useAppStore.getState();
    let agentId = "claude-code";
    try {
      const saved = JSON.parse(
        localStorage.getItem("ccode.lastLaunch") ?? "{}",
      ) as Partial<{ agentId: string }>;
      if (saved.agentId && AGENTS.some((a) => a.id === saved.agentId))
        agentId = saved.agentId;
    } catch {
      /* 损坏按默认 */
    }
    const pick =
      st.settings?.defaultProfiles?.[agentId] ||
      localStorage.getItem(`ccode.lastProfile.${agentId}`) ||
      "";
    const ok = st.profiles.find((p) => p.id === pick && p.agent === agentId)?.id;
    // 兜底挑首个时跳过隐藏项（同启动栏口径）；全被隐藏时仍从隐藏项里取，好过留空
    const hidden = st.settings?.hiddenProfiles ?? [];
    const visibleProfiles = st.profiles.filter(
      (p) => p.agent === agentId && !hidden.includes(p.id),
    );
    return {
      agentId,
      profileId:
        ok ??
        visibleProfiles[0]?.id ??
        st.profiles.find((p) => p.agent === agentId)?.id ??
        "",
    };
  }

  /** 派一个阅读会话标签（项目根 + 默认配置 + autoStart + reuseKey，快速开聊同款机制）；
      返回 false = 无可用配置（Agent 栏显示引导卡） */
  function dispatchReaderSession(r: {
    pdfPath: string;
    projectRoot: string;
  }): boolean {
    const launch = resolveReaderLaunch();
    if (!launch.profileId) return false;
    setPendingTerminal({
      cwd: r.projectRoot,
      extraEnv: {},
      title: `阅读 · ${basename(r.pdfPath).replace(/\.pdf$/i, "")}`,
      agentId: launch.agentId,
      profileId: launch.profileId,
      autoStart: true,
      reuseKey: readerReuseKey(r.projectRoot),
    });
    return true;
  }

  // 进入阅读区：还没有绑定本项目的阅读会话标签就自动起一个
  useEffect(() => {
    if (!visible || !reader || !readerKey) return;
    if (readerTabId) {
      setReaderNeedsProfile(false);
      return;
    }
    if (readerTriedRef.current === readerKey) return;
    const ok = dispatchReaderSession(reader);
    // 无配置不记一次性标记：配置页加好配置后 profiles 变化会自然重试
    readerTriedRef.current = ok ? readerKey : null;
    setReaderNeedsProfile(!ok);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reader, readerKey, readerTabId, profiles, readerAgentTick]);

  /** 阅读区注入（选段「↵ 直接发送」/ 输入框回车）：走与右栏选段同一条 injectToTab 链路，目标换成阅读会话标签 */
  const injectToReader = useCallback(
    (data: string, send?: boolean): string | null =>
      readerTabId
        ? injectToTab(readerTabId, data, send)
        : "阅读会话还没建好，稍等片刻再试",
    [injectToTab, readerTabId],
  );

  /** 阅读会话标签被手动关掉后的「重新启动」：清一次性标记再派一次 */
  const restartReaderAgent = useCallback(() => {
    readerTriedRef.current = null;
    setReaderAgentTick((t) => t + 1);
  }, []);

  const closeReader = useCallback(() => setReader(null), []);

  // 阅读区打开时把阅读会话标签提到活跃（右栏 xterm 就是那个标签的画面；退出阅读区正好落在它上面）
  useEffect(() => {
    if (!reader || !readerTabId || activeId === readerTabId) return;
    activateTab(readerTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, readerTabId, activeId]);

  // 阅读区打开期间：阅读会话标签的 xterm 宿主节点移进覆盖层右栏槽位，关闭时移回原标签槽位
  // （Monaco 宿主移动同款先例：DOM 搬移不重建，PTY/xterm/scrollback 全程不丢；
  // 容器上的 ResizeObserver 在尺寸变化时自动 fit，无需额外触发）。
  // 槽位用回调 ref + state：右栏收起/展开导致槽位卸载重建时 effect 随之复位/再搬。
  const [readerTermSlot, setReaderTermSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const bindReaderTermSlot = useCallback(
    (el: HTMLDivElement | null) => setReaderTermSlot(el),
    [],
  );
  const [readerStatusSlot, setReaderStatusSlot] =
    useState<HTMLDivElement | null>(null);
  const bindReaderStatusSlot = useCallback(
    (el: HTMLDivElement | null) => setReaderStatusSlot(el),
    [],
  );
  useLayoutEffect(() => {
    if (!reader || !readerTabId) return;
    const root = terminalRootRef.current;
    // host 与状态栏独立判定、分别搬运：两个槽位的挂载时机可能不同步
    // （右栏收起/展开会重建槽位），早退会漏搬后到的那一个
    const host = root?.querySelector<HTMLElement>(
      `[data-terminal-host="${readerTabId}"]`,
    );
    let hostHome: HTMLElement | null = null;
    if (host && readerTermSlot) {
      const home = host.parentElement;
      if (home && home !== readerTermSlot) {
        readerTermSlot.appendChild(host);
        hostHome = home;
      }
    }
    // 状态栏随宿主一起搬（同 DOM 搬移口径）：右栏底部槽位存在才搬，槽位缺席（引导卡等）留在原 pane
    const bar = root?.querySelector<HTMLElement>(
      `[data-statusbar-host="${readerTabId}"]`,
    );
    let barHome: HTMLElement | null = null;
    if (bar && readerStatusSlot) {
      const home = bar.parentElement;
      if (home && home !== readerStatusSlot) {
        readerStatusSlot.appendChild(bar);
        barHome = home;
      }
    }
    return () => {
      // 移回原槽位：host 原是容器第一个孩子；状态栏原是 pane-body 最后一个孩子。
      // 标签被关时 TerminalView 卸载、home 已不在文档里（React 只卸其自身子树，
      // 搬走的节点不在其中），isConnected 跳过硬挂
      if (host && hostHome?.isConnected)
        hostHome.insertBefore(host, hostHome.firstChild);
      if (bar && barHome?.isConnected) barHome.appendChild(bar);
    };
  }, [reader, readerTabId, readerTermSlot, readerStatusSlot]);

  /** 「⛶ 沉浸阅读」入口（PDF 预览工具条 / 文件树右键共用）：反查归属项目后开覆盖层 */
  async function openReaderForPdf(pdfPath: string) {
    try {
      const owner = await invoke<ProjectDto | null>("pdf_owner_project", {
        pdfPath,
      });
      if (!owner) {
        void alertDialog(
          "该 PDF 不在任何项目里，先在项目资源里登记再沉浸阅读",
        );
        return;
      }
      setReviewPath(null);
      setReviewAction(null);
      setReader({ pdfPath, projectRoot: owner.path });
    } catch (e) {
      void alertDialog(String(e));
    }
  }

  /** md 笔记「⛶ 沉浸阅读」入口（文件树右键 / 预览工具条）：reader_for_note 一次给齐
      归属项目根 + 配对 PDF + 实际笔记路径（工作区笔记映射回主仓副本；失败原因直接弹给用户） */
  async function openReaderForNote(notePath: string) {
    try {
      const r = await invoke<{
        projectRoot: string;
        pdfPath: string;
        notePath: string;
      }>("reader_for_note", { notePath });
      setReviewPath(null);
      setReviewAction(null);
      setReader({
        pdfPath: r.pdfPath,
        projectRoot: r.projectRoot,
        notePath: r.notePath,
      });
    } catch (e) {
      void alertDialog(String(e));
    }
  }

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
          action: { label: "去项目页登记", run: () => setPage("workspaces") },
        };
      }
      const read = await invoke<ProjectConfigReadDto>("read_project_config", {
        path: owner.path,
      });
      const cfg = read.config;
      // 笔记步骤定位规则（简单可靠）：优先 workspaceName === "lit-notes"（默认模板第二步）；
      // 用户改过工作区名时回落研究流程第二步（文献精读通常排在检索之后）
      const step =
        cfg.steps.find((s) => s.workspaceName === "lit-notes") ?? cfg.steps[1];
      if (!step?.workspaceName) {
        return {
          ok: false,
          msg: "该项目研究流程中没有笔记步骤：请把工作区名设为 lit-notes 的步骤，或保留研究流程前两步",
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

  // 长任务 OS 通知（P3）：attention 跃迁（非→待确认）且窗口未聚焦时发系统通知。
  // 「已回复」不通知——回合结束每轮都发生、不阻塞决策。只 watch 终端标签 statuses；
  // 对话页/工作区页的状态变化 v1 不通知。
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
      if (!attentionTransition(prev, s.attention)) continue;
      // 设置开关关闭时完全不请求权限、不发通知
      if (!notificationsEnabled) continue;
      if (!document.hidden && windowFocusedRef.current) continue;
      const now = Date.now();
      if (!debounceAllows(notifySentAtRef.current.get(tabId), now)) continue;
      notifySentAtRef.current.set(tabId, now);
      void fireAttentionNotification(
        notifyTitle(s.title, agentLabel(s.agentId)),
        NOTIFY_BODY,
        { tabId, cwd: s.cwd },
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
    "flex h-7 w-7 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l2";

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
              className={`flex h-7 w-7 items-center justify-center rounded-sm text-xs hover:bg-hover ${
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
              onRootNavigated={setTreeRoot}
              onRecoverDirectory={() =>
                tabActionsRef.current.get(focusedId)?.chooseCwd()
              }
              onOpenReader={(path) =>
                void (/\.pdf$/i.test(path)
                  ? openReaderForPdf(path)
                  : openReaderForNote(path))
              }
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
          {tabs.map((t, tabIndex) => {
            const s = statuses[t.id];
            const active = t.id === activeId;
            // 注意力点：仅 工作中/待确认 有状态时才渲染，无状态/空闲不渲染（降噪）；
            // 「已回复」不打点——回合结束每轮都发生，不是待办。
            // 与关闭 × 一样只在悬停 / 激活 / 键盘聚焦（focus-within）时显现。
            const attentionDot =
              s?.attention === "working"
                ? { cls: "text-ok-text animate-pulse-brief", tip: "工作中" }
                : s?.attention === "confirm"
                  ? { cls: "text-warn-text", tip: "待确认" }
                  : null;
            // 拖拽（Ghostty 式）：源标签跟手平移；位于「原位置→目标位置」之间的标签
            // 各退/进一个槽位（滑动让位）；松手时源标签 transition 吸附到目标槽位后重排
            const isDragSource = tabDrag?.id === t.id;
            let shift = 0;
            if (tabDrag && !isDragSource) {
              const { from, target, rects } = tabDrag;
              if (from < target && tabIndex > from && tabIndex <= target) {
                shift = rects[tabIndex - 1].left - rects[tabIndex].left;
              } else if (from > target && tabIndex < from && tabIndex >= target) {
                shift = rects[tabIndex + 1].left - rects[tabIndex].left;
              }
            }
            return (
              <div
                key={t.id}
                data-tab-id={t.id}
                onClick={() => {
                  // 拖拽落定后的那次 click 吞掉（拖排序不该顺手切换标签）
                  if (suppressTabClickRef.current) {
                    suppressTabClickRef.current = false;
                    return;
                  }
                  activateTab(t.id);
                }}
                onPointerDown={(e) => onTabPointerDown(e, t.id)}
                style={{
                  transform:
                    isDragSource && tabDrag
                      ? `translateX(${tabDrag.dx}px)`
                      : shift !== 0
                        ? `translateX(${shift}px)`
                        : undefined,
                  // 让位标签始终滑动；源标签跟手不动画、吸附时才有
                  transition:
                    tabDrag && (!isDragSource || tabDrag.settling)
                      ? "transform 150ms ease"
                      : undefined,
                  // 源标签浮在让位标签之上（零阴影体系下用层级表达浮起）
                  position: isDragSource ? "relative" : undefined,
                  zIndex: isDragSource ? 10 : undefined,
                }}
                className={`group/tab flex h-9 w-[130px] min-w-[100px] shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-xs ${
                  active
                    ? "border-cta text-l1"
                    : "border-transparent text-l3 hover:text-l1"
                } ${isDragSource ? "bg-raised" : ""}`}
              >
                {attentionDot && (
                  <span
                    className={`shrink-0 text-micro ${attentionDot.cls} ${
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
                  <span
                    className="shrink-0 text-micro text-l4"
                    title="应用重启前未结束的任务，点「恢复任务」重建"
                  >
                    可恢复
                  </span>
                )}
                {splitActive && t.id === splitTabId && (
                  <span
                    className="shrink-0 rounded-sm bg-inset px-1 text-micro text-l3"
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
            className="shrink-0 rounded-sm px-1.5 text-sm text-l4 hover:text-l1"
          >
            ＋
          </button>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {/* 布局三开关合成一个分段控件（v3.88）：分屏 / 工作台 / 专注终端本질上是同一维度
                ——「这块屏怎么排」。三个独立按钮各占一格、视觉同权重，是标签条最挤的一段。
                互斥高亮后语义更清楚，也省两个按钮宽度。git 芯片与可合并 pill 是**结果不是入口**，
                已下移到中带底部状态条（见下方 statusBar），不与标签抢注意力 */}
            <span className="flex items-center rounded-sm bg-inset p-0.5">
              <button
                type="button"
                onClick={toggleSplit}
                disabled={!splitActive && tabs.length < 2}
                title={
                  splitActive
                    ? "退出分屏"
                    : "分屏对比：左侧当前标签，右侧任选对照标签（需要至少两个标签）"
                }
                aria-pressed={splitActive}
                className={`rounded-sm px-1.5 py-0.5 text-xs disabled:opacity-40 ${
                  splitActive ? "bg-seg-sel text-l1" : "text-l4 hover:text-l2"
                }`}
              >
                ◧
              </button>
              <button
                type="button"
                onClick={() => setRightOpen((v) => !v)}
                title="成果工作台（对话 / 文件 / 改动）"
                aria-label="成果工作台"
                aria-pressed={rightOpen}
                className={`rounded-sm px-1.5 py-0.5 text-xs ${
                  rightOpen ? "bg-seg-sel text-l1" : "text-l4 hover:text-l2"
                }`}
              >
                ◫
              </button>
              <button
                type="button"
                onClick={() => setFocusMode((v) => !v)}
                title={
                  focusMode
                    ? "退出专注终端（Esc，恢复左右栏）"
                    : "专注终端（隐藏左右栏，Esc 退出）"
                }
                aria-pressed={focusMode}
                className={`rounded-sm px-1.5 py-0.5 text-xs ${
                  focusMode ? "bg-seg-sel text-l1" : "text-l4 hover:text-l2"
                }`}
              >
                ⤢
              </button>
            </span>
            {/* ⋯ 改为常驻（v3.88）：原先只在专注模式渲染，非专注时同一批动作散在标签内
                启动栏的 ⋯ 里，两套菜单内容高度重叠。现在合为一处、位置固定 */}
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setFocusMenu({ x: r.right, y: r.bottom + 4 });
              }}
              title="终端操作（停止/恢复/接力/对话/查找/修改）"
              aria-label="终端操作"
              className="rounded-sm px-2 py-0.5 text-xs text-l4 hover:text-l2"
            >
              ⋯
            </button>
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
                readonly={t.readonly}
                restored={t.restored}
                stepClaimName={t.stepName}
                externalCwd={t.id === focusedId ? enterCwd : null}
                onConsumeExternalCwd={consumeExternalCwd}
                onStatus={reportStatus}
                onSessionUpdate={reportSession}
                onHandoff={setHandoffSource}
                onDigest={setDigestSource}
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
                        <span className="shrink-0 text-micro text-l4">
                          对照
                        </span>
                        <select
                          value={splitTabId ?? ""}
                          onChange={(e) => setSplitTabId(e.target.value)}
                          className="h-6 min-w-0 flex-1 rounded-sm border border-field bg-inset px-1.5 text-xs text-l2 outline-none focus:border-l4"
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
                        <span className="shrink-0 text-micro text-l4">
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
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1"
                    >
                      ×
                    </button>
                  </div>
                )}
                <div key="pane-body" className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">{view}</div>
                  {/* 终端底部状态栏：在 pane 内部、贴 xterm 画面下缘，与终端同底同色
                      （视觉上是终端自己画的状态行）。常驻渲染——未启动也有 cwd/未启动态，
                      高度恒定不跳动；ResizeObserver 兜底尺寸变化后的 fit。
                      分屏时各 pane 显示各标签；git 段只跟随活跃 pane（数据是 focusedId 的）。
                      data-statusbar-host：阅读区打开时随 xterm 宿主一并搬进覆盖层右栏槽位 */}
                  <div data-statusbar-host={t.id} className="shrink-0">
                  {(() => {
                    const st = statuses[t.id] ?? null;
                    const prof = st
                      ? profiles.find((p) => p.id === st.profileId)
                      : null;
                    const det = st
                      ? agents.find((a) => a.id === st.agentId)
                      : null;
                    const focused = t.id === focusedId;
                    return (
                      <TerminalStatusBar
                        status={st}
                        fallbackCwd={t.initialCwd ?? ""}
                        profileName={prof?.name ?? null}
                        profileModels={prof?.models ?? []}
                        modelSwitch={det?.modelSwitch ?? null}
                        effort={det?.effort ?? null}
                        git={focused ? gitTotals : null}
                        mergeReady={focused ? mergeReadyWs : []}
                        gitCwd={gitPanelCwd}
                        submitCsiU={det?.submitCsiU ?? false}
                        onOpenGit={() => {
                          setRightOpen(true);
                          setRightTab("git");
                        }}
                        onGenerateMsg={generateCommitMsg}
                        onCommitPush={commitPushMsg}
                        onCwdChange={(c) =>
                          tabActionsRef.current.get(t.id)?.setCwd(c)
                        }
                        onTermLog={(line) =>
                          tabActionsRef.current.get(t.id)?.logLine(line)
                        }
                        colors={statusBarColors}
                      />
                    );
                  })()}
                  </div>
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

      {/* 右栏关闭（或专注终端）时改动面板随右栏卸载、轮询停止，标签条变更芯片与页签徽标需要数据：
          挂一个 display:none 的实例在同一 cwd 上持续轮询（与右栏内的面板实例互斥，永不同存） */}
      {(!rightOpen || focusMode) && (
        <div className="hidden">
          <GitPanel
            cwd={gitPanelCwd}
            visible={visible}
            refreshKey={fsChangeTick}
            onTotals={reportGitTotals}
          />
        </div>
      )}

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
            {/* 页签与面板头部合并为一行（走查去重）：左侧三页签，右侧面板动作
                （↺ 完整回放 / ⇱ 专注内容 / × 收起，低频 hover 才现）；不再单设「工作台」标题行，
                会话上下文在「对话」页签底部细条（v3.91 迁出，页签行不再截断） */}
            <div className="group flex h-9 shrink-0 items-center gap-1 border-b border-hairline bg-raised px-2">
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
                    className={`flex h-8 shrink-0 items-center gap-1 rounded-sm px-2.5 text-xs ${
                      rightTab === k
                        ? "bg-seg-sel text-l1"
                        : "text-l3 hover:text-l1"
                    }`}
                  >
                    <span className="text-micro text-l4">{symbol}</span>
                    {label}
                    {k === "dialogue" && dialogueCount > 0 && (
                      <span
                        className="ml-1 rounded-sm bg-inset px-1 text-micro text-l3"
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
                      <span className="ml-1 rounded-sm bg-ok px-1 text-ok-text">
                        +{gitBadge}
                      </span>
                    )}
                  </button>
                );
              })}
              {/* 右侧动作区：完整回放（↺ 图标，hover 才现）+ 专注内容 + 收起。
                  会话上下文（状态点 + 标题/agent/会话/状态）已迁到「对话」页签底部细条（v3.91），
                  页签行只留三页签，不再截断 */}
              <span className="ml-auto flex min-w-0 items-center gap-1 pl-1">
                {rightTab === "dialogue" && (
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
                    title="完整回放"
                    className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 disabled:opacity-40 ${hoverRevealClass}`}
                  >
                    ↺
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleRightExpanded}
                  title={
                    rightExpanded
                      ? "退出专注内容（Esc，恢复工作树分栏）"
                      : "专注内容（暂时隐藏工作树，右栏铺满，Esc 退出）"
                  }
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
                >
                  {rightExpanded ? "⇲" : "⇱"}
                </button>
                <button
                  onClick={closeRightPanel}
                  title="收起工作台"
                  className={`flex size-7 shrink-0 items-center justify-center rounded-sm text-xs text-l4 hover:bg-hover hover:text-l1 ${hoverRevealClass}`}
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
                    className="absolute bottom-3 right-3 rounded-sm border border-field bg-strip px-2.5 py-1 text-xs text-l2 hover:bg-inset hover:text-l1"
                  >
                    有新消息 ↓
                  </button>
                )}
              </div>
              {/* 会话底条（v3.91）：状态点 + 标题/agent/会话/状态，整条可点进完整回放。
                  从页签行迁来——页签行只留三页签，标题不再被截断；点按全局 size-2 对齐 */}
              <button
                type="button"
                disabled={!activeSession?.sessionId || !activeSession.agentId}
                onClick={() => {
                  if (!activeSession?.sessionId || !activeSession.agentId)
                    return;
                  setOpenSessionReq({
                    agent: activeSession.agentId,
                    sessionId: activeSession.sessionId,
                  });
                  setPage("sessions");
                }}
                title={
                  activeSession?.sessionId
                    ? `会话 ${activeSession.sessionId}（点击完整回放）`
                    : "启动 Agent 后这里显示当前会话"
                }
                className="flex h-7 shrink-0 items-center gap-2 border-t border-hairline px-3 text-left text-micro text-l4 enabled:hover:bg-hover disabled:cursor-default"
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    statuses[focusedId]?.running
                      ? "bg-ok-text"
                      : activeSession?.state === "timeout"
                        ? "bg-warn-text"
                        : "bg-l4"
                  }`}
                />
                {/* 与底部终端状态栏差异化（v3.92）：这里只讲「对话」自己的事——
                    未关联时报关联状态，关联后报会话标题/状态/token，不重复 agent · 配置 */}
                <span className="min-w-0 truncate">
                  {activeSession?.sessionId ? (
                    <>
                      <span className="text-l2">
                        {activeSession.title ||
                          statuses[focusedId]?.title ||
                          "当前对话"}
                      </span>
                      {` · ${activeSession.sessionId.slice(0, 8)}`}
                      {activeSession.state === "detecting"
                        ? " · 识别中"
                        : activeSession.state === "timeout"
                          ? " · 等待关联"
                          : activeSession.file
                            ? statuses[focusedId]?.running
                              ? " · 同步中"
                              : " · 已结束"
                            : ""}
                    </>
                  ) : statuses[focusedId]?.running ? (
                    "Agent 运行中 · 等待会话关联"
                  ) : (
                    "未关联会话 · 启动后自动同步"
                  )}
                </span>
                {footerUsage &&
                  (footerUsage.input > 0 || footerUsage.output > 0) && (
                    <span
                      className="ml-auto shrink-0 font-mono"
                      title="本会话累计 token（随索引节奏更新，约 1 分钟粒度）"
                    >
                      {fmtTokens(footerUsage.input)}↑ {fmtTokens(footerUsage.output)}↓
                    </span>
                  )}
              </button>
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
                      onOpenReader={() => void openReaderForPdf(preview.path)}
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
                      onOpenReader={
                        /\.md$/i.test(preview.path)
                          ? () => void openReaderForNote(preview.path)
                          : undefined
                      }
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
                cwd={gitPanelCwd}
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

      {/* 沉浸式阅读区（z-40 页面模态档）：底下终端/PTY/右栏全程保持挂载，只是被盖住；
          右栏 xterm 由上面的 useLayoutEffect 把阅读会话标签的宿主节点搬进 termSlot */}
      {reader && (
        <ReaderOverlay
          pdfPath={reader.pdfPath}
          projectRoot={reader.projectRoot}
          notePath={reader.notePath ?? null}
          hasAgentTab={readerTabId !== null}
          agentStatus={readerTabId ? (statuses[readerTabId] ?? null) : null}
          agentSession={
            readerTabId ? (sessionByTab[readerTabId] ?? null) : null
          }
          needsProfile={readerNeedsProfile}
          onInject={injectToReader}
          onRestartAgent={restartReaderAgent}
          onGoProfiles={() => setPage("profiles")}
          onClose={closeReader}
          termSlot={bindReaderTermSlot}
          statusBarSlot={bindReaderStatusSlot}
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
      {digestSource && (
        <DigestPicker
          source={digestSource}
          onClose={() => setDigestSource(null)}
        />
      )}
    </div>
  );
}
