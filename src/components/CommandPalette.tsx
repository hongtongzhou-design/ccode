import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import { filterCommands, type PaletteCommand } from "../command-palette";
import { THEMES } from "../themes";

const PAGE_COMMANDS: {
  id: string;
  label: string;
  icon: string;
  hint: string;
}[] = [
  { id: "workspaces", label: "工作区", icon: "⛁", hint: "⌘1" },
  { id: "terminal", label: "终端", icon: "⌨", hint: "⌘2" },
  { id: "sessions", label: "对话", icon: "◔", hint: "⌘3" },
  { id: "profiles", label: "配置", icon: "⇄", hint: "⌘4" },
  { id: "skills", label: "技能", icon: "✦", hint: "⌘5" },
  { id: "mcp", label: "MCP", icon: "⌗", hint: "⌘6" },
  { id: "stats", label: "统计", icon: "◫", hint: "⌘7" },
  { id: "settings", label: "设置", icon: "⛭", hint: "⌘8" },
];

/**
 * ⌘K 命令面板（浮层，边框按浮层规则保留）：页面跳转 / 主题切换 / 侧栏显隐。
 * ↑↓ 移动、Enter 执行、Esc 或点遮罩关闭；执行后一律关闭。
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const setPage = useAppStore((s) => s.setPage);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const chromeHidden = useAppStore((s) => s.chromeHidden);
  const toggleChromeHidden = useAppStore((s) => s.toggleChromeHidden);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<{ cmd: PaletteCommand; run: () => void }[]>(
    () => [
      ...PAGE_COMMANDS.map((p) => ({
        cmd: {
          id: `page:${p.id}`,
          title: `${p.icon} ${p.label}`,
          hint: p.hint,
          keywords: [p.id, p.label, "页面", "page"],
        },
        run: () => setPage(p.id),
      })),
      ...THEMES.map((t) => ({
        cmd: {
          id: `theme:${t.id}`,
          title: `主题：${t.name}`,
          keywords: ["theme", "主题", t.id, t.name],
        },
        run: () => void updateSettings({ theme: t.id }),
      })),
      {
        cmd: {
          id: "chrome:toggle",
          title: chromeHidden ? "显示侧栏" : "隐藏侧栏",
          hint: "⌘\\",
          keywords: ["sidebar", "侧栏", "chrome"],
        },
        run: toggleChromeHidden,
      },
    ],
    [setPage, updateSettings, chromeHidden, toggleChromeHidden],
  );

  const filtered = useMemo(
    () => filterCommands(commands.map((c) => c.cmd), query),
    [commands, query],
  );

  const runAt = (i: number) => {
    const item = filtered[i];
    if (!item) return;
    onClose();
    commands.find((c) => c.cmd.id === item.id)?.run();
  };

  // 打开即聚焦输入框；查询变化回到首行
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="命令面板"
        className="mt-[16vh] h-fit w-[30rem] overflow-hidden rounded-md border border-field ccode-float-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(index);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="跳页面、换主题、隐侧栏…"
          className="h-11 w-full border-b border-hairline bg-transparent px-3.5 text-sm text-l1 outline-none placeholder:text-l4"
        />
        <ul className="max-h-80 overflow-auto py-1">
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => runAt(i)}
                onMouseEnter={() => setIndex(i)}
                className={`flex h-9 w-full items-center gap-2 px-3.5 text-left text-sm ${
                  i === index ? "bg-seg-sel text-l1" : "text-l2"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.hint && (
                  <span className="shrink-0 font-mono text-xs text-l4">
                    {c.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3.5 py-4 text-xs text-l4">没有匹配的命令</li>
          )}
        </ul>
      </div>
    </div>
  );
}
