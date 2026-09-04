import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FolderClosed, FolderOpen } from "lucide-react";
import { FoldMark, rowActionClass } from "./PageFrame";
import { listPreviewToggleLabel } from "../lit-list";
import {
  countTreeFiles,
  folderFoldStorageKey,
  parseExpandedFolders,
  serializeExpandedFolders,
  treeHasFolders,
  type FolderNode,
} from "../folder-groups";

function readExpanded(scope?: string): Set<string> {
  if (!scope) return new Set();
  try {
    return parseExpandedFolders(
      localStorage.getItem(folderFoldStorageKey(scope)),
    );
  } catch {
    return new Set();
  }
}

function writeExpanded(scope: string, expanded: Set<string>) {
  try {
    localStorage.setItem(
      folderFoldStorageKey(scope),
      serializeExpandedFolders(expanded),
    );
  } catch {
    /* 隐私模式 */
  }
}

/** 记住展开过的夹；没记过的默认收起。scope 变了（换项目）会重读。 */
export function useFolderChrome(scope?: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readExpanded(scope),
  );
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setExpanded(readExpanded(scope));
    setRevealed(new Set());
  }, [scope]);
  const toggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) next.delete(dir);
        else next.add(dir);
        if (scope) writeExpanded(scope, next);
        return next;
      });
    },
    [scope],
  );
  const reveal = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return { expanded, toggle, revealed, reveal };
}

/** 列表预览条：缩进写在外层，避免 paddingLeft 把按钮左右内边距挤歪。 */
export function ListPreviewToggle({
  open,
  hidden,
  unit = "篇",
  className = "",
  onToggle,
}: {
  open: boolean;
  hidden: number;
  unit?: string;
  className?: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={`${rowActionClass} ${className}`}
      aria-expanded={open}
      onClick={() => {
        const collapsing = open;
        onToggle();
        if (collapsing) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              ref.current?.scrollIntoView({
                block: "nearest",
                behavior: "smooth",
              });
            });
          });
        }
      }}
    >
      {listPreviewToggleLabel(open, hidden, unit)}
    </button>
  );
}

function FolderNodeView<T>({
  node,
  depth,
  searching,
  expanded,
  onToggle,
  cap,
  revealed,
  onReveal,
  rowKey,
  renderRow,
}: {
  node: FolderNode<T>;
  depth: number;
  searching: boolean;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  cap: number;
  revealed: Set<string>;
  onReveal: (key: string) => void;
  rowKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  const isRoot = !node.path;
  const open = isRoot || searching || expanded.has(node.path);
  const uncapped = searching || cap <= 0 || revealed.has(node.path);
  const visible = uncapped ? node.files : node.files.slice(0, cap);
  const innerDepth = isRoot ? depth : depth + 1;
  const headPad = { paddingLeft: depth * 12 };
  const bodyPad = { paddingLeft: innerDepth * 12 };

  return (
    <div className="min-w-0">
      {!isRoot && (
        <button
          type="button"
          className="flex min-h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left hover:bg-hover"
          style={headPad}
          onClick={() => onToggle(node.path)}
          aria-expanded={open}
        >
          <FoldMark open={open} />
          {open ? (
            <FolderOpen
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-l3"
            />
          ) : (
            <FolderClosed
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-l3"
            />
          )}
          <span className="min-w-0 truncate text-sm text-l1">{node.name}</span>
          <span className="shrink-0 text-micro text-l4">
            （{countTreeFiles(node)}）
          </span>
        </button>
      )}
      {open && (
        <>
          {node.folders.map((child) => (
            <FolderNodeView
              key={child.path}
              node={child}
              depth={innerDepth}
              searching={searching}
              expanded={expanded}
              onToggle={onToggle}
              cap={cap}
              revealed={revealed}
              onReveal={onReveal}
              rowKey={rowKey}
              renderRow={renderRow}
            />
          ))}
          {visible.length > 0 && (
            <ul className="min-w-0 space-y-0.5" style={isRoot ? undefined : bodyPad}>
              {visible.map((item) => (
                <Fragment key={rowKey(item)}>{renderRow(item)}</Fragment>
              ))}
            </ul>
          )}
          {!searching && cap > 0 && node.files.length > cap && (
            <div className="mt-1" style={isRoot ? undefined : bodyPad}>
              <ListPreviewToggle
                open={revealed.has(node.path)}
                hidden={node.files.length - cap}
                onToggle={() => onReveal(node.path)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function FolderGroupedList<T>({
  tree,
  searching,
  expanded,
  onToggle,
  cap,
  revealed,
  onReveal,
  rowKey,
  renderRow,
}: {
  tree: FolderNode<T>;
  searching: boolean;
  expanded: Set<string>;
  onToggle: (dir: string) => void;
  cap: number;
  revealed: Set<string>;
  onReveal: (key: string) => void;
  rowKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
}) {
  if (!treeHasFolders(tree) && tree.files.length === 0) return null;
  return (
    <FolderNodeView
      node={tree}
      depth={0}
      searching={searching}
      expanded={expanded}
      onToggle={onToggle}
      cap={cap}
      revealed={revealed}
      onReveal={onReveal}
      rowKey={rowKey}
      renderRow={renderRow}
    />
  );
}
