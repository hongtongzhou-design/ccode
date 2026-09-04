/**
 * 项目页按相对路径做成分级文件夹树（办公文档 / 无流程文献与笔记）。
 * 根上的文件不套组头；有子目录才出文件夹行。
 */

export function relFileSegments(rel: string, stripPrefix?: string): string[] {
  let p = rel.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!p) return [];
  if (stripPrefix) {
    const pre = stripPrefix.replace(/\/+$/, "");
    if (p === pre) return [];
    if (p.startsWith(`${pre}/`)) p = p.slice(pre.length + 1);
  }
  return p.split("/").filter(Boolean);
}

/** 父目录路径；根文件为 null。保留给单测与旧调用。 */
export function fileDirKey(rel: string, stripPrefix?: string): string | null {
  const segs = relFileSegments(rel, stripPrefix);
  if (segs.length <= 1) return null;
  return segs.slice(0, -1).join("/");
}

export type FolderNode<T> = {
  name: string;
  path: string;
  files: T[];
  folders: FolderNode<T>[];
};

function sortName(a: string, b: string): number {
  return a.localeCompare(b, "zh");
}

function sortTree<T>(node: FolderNode<T>) {
  node.folders.sort((a, b) => sortName(a.name, b.name));
  for (const child of node.folders) sortTree(child);
}

export function buildFolderTree<T>(
  items: readonly T[],
  relOf: (item: T) => string,
  stripPrefix?: string,
): FolderNode<T> {
  const root: FolderNode<T> = { name: "", path: "", files: [], folders: [] };
  for (const item of items) {
    const segs = relFileSegments(relOf(item), stripPrefix);
    if (segs.length <= 1) {
      root.files.push(item);
      continue;
    }
    let node = root;
    let acc = "";
    for (const dir of segs.slice(0, -1)) {
      acc = acc ? `${acc}/${dir}` : dir;
      let child = node.folders.find((f) => f.name === dir);
      if (!child) {
        child = { name: dir, path: acc, files: [], folders: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(item);
  }
  sortTree(root);
  return root;
}

export function countTreeFiles<T>(node: FolderNode<T>): number {
  let n = node.files.length;
  for (const child of node.folders) n += countTreeFiles(child);
  return n;
}

export function treeHasFolders<T>(node: FolderNode<T>): boolean {
  return node.folders.length > 0;
}

/** localStorage 键：按列表种类 + 项目路径记住展开过的夹。 */
export function folderFoldStorageKey(scope: string): string {
  return `ccode.folderFold.${scope.replace(/[\\/]+$/, "")}`;
}

/** 解析已展开路径；坏数据 / 空 = 全部收起。 */
export function parseExpandedFolders(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function serializeExpandedFolders(expanded: Iterable<string>): string {
  return JSON.stringify([...expanded]);
}
