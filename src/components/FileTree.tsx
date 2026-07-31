import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ContextMenu from "./ContextMenu";

export interface DirEntryDto {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string | null;
}

function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** 上一级目录；已到文件系统根（或无法再上）时返回 null */
function parentDir(p: string): string | null {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return null; // 形如 "~" 或 "C:"，无法再上
  if (idx === 0) return trimmed[0] === "/" ? "/" : null;
  return trimmed.slice(0, idx);
}

/**
 * 工作树（借鉴 VS Code Explorer 的懒加载）：外部锚点是活动终端标签的 cwd，
 * 用户可双击目录钻取重定根（manual root），切换标签时重置回该标签 cwd。
 * 单击目录 = 展开/收起；双击目录 = 进入（重定根）；右键 / 悬停按钮 = 在此打开新终端。
 */
export default function FileTree({
  cwd,
  showHidden,
  refreshKey,
  onOpenFile,
  onOpenTerminal,
}: {
  cwd: string;
  showHidden: boolean;
  refreshKey: number;
  onOpenFile: (path: string, name: string) => void;
  onOpenTerminal: (path: string) => void;
}) {
  // manual root：默认锚定活动标签 cwd，钻取/上级由用户驱动
  const [root, setRoot] = useState(cwd);
  const [cache, setCache] = useState<Record<string, DirEntryDto[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  // 切换活动标签（cwd 变化）时重置回该标签的 cwd
  useEffect(() => {
    setRoot(cwd);
  }, [cwd]);

  const load = useCallback(
    async (path: string) => {
      try {
        const entries = await invoke<DirEntryDto[]>("list_dir", { path, showHidden });
        setCache((prev) => ({ ...prev, [path]: entries }));
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [showHidden],
  );

  // 重定根 / 显隐切换：清空缓存与展开状态
  useEffect(() => {
    setCache({});
    setExpanded(new Set());
  }, [root, showHidden]);

  // 手动刷新：只清缓存，展开状态保留（展开的节点会自动重载）
  useEffect(() => {
    if (refreshKey > 0) setCache({});
  }, [refreshKey]);

  // 根目录缓存缺失时加载
  useEffect(() => {
    if (!cache[root]) void load(root);
  }, [cache, root, load]);

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const parent = parentDir(root);

  function Node({ entry, depth }: { entry: DirEntryDto; depth: number }) {
    const isOpen = expanded.has(entry.path);
    const children = cache[entry.path];
    // 展开才读取子目录（懒加载）
    useEffect(() => {
      if (entry.isDir && isOpen && !children) void load(entry.path);
    }, [isOpen, entry.isDir, entry.path, children, load]);
    return (
      <>
        <div
          onClick={() =>
            entry.isDir ? toggle(entry.path) : onOpenFile(entry.path, entry.name)
          }
          onDoubleClick={() => {
            if (entry.isDir) setRoot(entry.path);
          }}
          onContextMenu={(e) => {
            if (!entry.isDir) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, path: entry.path });
          }}
          title={entry.isDir ? `${entry.path}\n双击进入，右键在此打开终端` : entry.path}
          className="group flex cursor-pointer items-center gap-1 py-0.5 pr-2 text-xs hover:bg-neutral-100"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="w-3 shrink-0 text-neutral-400">
            {entry.isDir ? (isOpen ? "▾" : "▸") : ""}
          </span>
          <span className="shrink-0">{entry.isDir ? "📁" : "📄"}</span>
          <span className="truncate text-neutral-700">{entry.name}</span>
          {entry.isDir && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenTerminal(entry.path);
              }}
              title="在此打开新终端"
              className="ml-auto hidden shrink-0 text-neutral-400 hover:text-blue-600 group-hover:block"
            >
              ↗
            </button>
          )}
        </div>
        {entry.isDir && isOpen && !children && (
          <div
            className="py-0.5 text-xs text-neutral-400"
            style={{ paddingLeft: 6 + (depth + 1) * 12 }}
          >
            加载中…
          </div>
        )}
        {entry.isDir &&
          isOpen &&
          children?.map((c) => <Node key={c.path} entry={c} depth={depth + 1} />)}
      </>
    );
  }

  const children = cache[root];
  return (
    <div>
      {/* 当前根：加粗 basename + 完整路径 tooltip */}
      <div
        className="border-b border-neutral-100 px-2 py-1 text-xs font-semibold text-neutral-700"
        title={root}
      >
        <span className="truncate">{basenameOf(root)}</span>
      </div>
      {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
      {parent && (
        <div
          onClick={() => setRoot(parent)}
          title={parent}
          className="cursor-pointer px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
        >
          ‥ 上级目录
        </div>
      )}
      {!children ? (
        <p className="px-2 py-1 text-xs text-neutral-400">加载中…</p>
      ) : children.length === 0 ? (
        <p className="px-2 py-1 text-xs text-neutral-400">空目录</p>
      ) : (
        children.map((c) => <Node key={c.path} entry={c} depth={0} />)
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "在此打开新终端",
              onSelect: () => onOpenTerminal(menu.path),
            },
          ]}
        />
      )}
    </div>
  );
}
