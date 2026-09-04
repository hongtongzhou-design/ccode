/**
 * 文件类型小图标（改动面板等文件列表的行首标识）：扩展名 → 短标签 + 固定识别色。
 * 颜色不随主题变化（同 VS Code 文件图标的固定配色，靠颜色认类型）；
 * 未收录的类型返回 null，调用方留空槽位保持对齐。纯逻辑，无渲染依赖。
 */

export interface FileTypeIcon {
  /** 1–3 个字符的短标签（避开冷门符号字体，只用常见字形） */
  label: string;
  /** 固定识别色（hex，深色/浅色主题下均可读） */
  color: string;
}

const EXT_ICONS: Record<string, FileTypeIcon> = {
  md: { label: "M↓", color: "#5ca861" },
  markdown: { label: "M↓", color: "#5ca861" },
  mdx: { label: "M↓", color: "#5ca861" },
  qmd: { label: "M↓", color: "#5ca861" },
  tsx: { label: "⚛", color: "#61dafb" },
  jsx: { label: "⚛", color: "#61dafb" },
  ts: { label: "TS", color: "#3178c6" },
  mts: { label: "TS", color: "#3178c6" },
  cts: { label: "TS", color: "#3178c6" },
  js: { label: "JS", color: "#c9a227" },
  mjs: { label: "JS", color: "#c9a227" },
  cjs: { label: "JS", color: "#c9a227" },
  rs: { label: "R", color: "#dea584" },
  py: { label: "Py", color: "#4b8bbe" },
  go: { label: "Go", color: "#29a8c9" },
  java: { label: "J", color: "#cc7832" },
  c: { label: "C", color: "#649ad2" },
  h: { label: "H", color: "#649ad2" },
  cpp: { label: "C+", color: "#649ad2" },
  cc: { label: "C+", color: "#649ad2" },
  cxx: { label: "C+", color: "#649ad2" },
  json: { label: "{}", color: "#a8a832" },
  jsonc: { label: "{}", color: "#a8a832" },
  toml: { label: "⚙", color: "#9c9c9c" },
  yaml: { label: "Y", color: "#cc3e44" },
  yml: { label: "Y", color: "#cc3e44" },
  html: { label: "<>", color: "#e34c26" },
  htm: { label: "<>", color: "#e34c26" },
  css: { label: "#", color: "#519aba" },
  scss: { label: "#", color: "#c6538c" },
  vue: { label: "V", color: "#41b883" },
  sh: { label: "$", color: "#8fbc5a" },
  bash: { label: "$", color: "#8fbc5a" },
  zsh: { label: "$", color: "#8fbc5a" },
  txt: { label: "≡", color: "#9c9c9c" },
  log: { label: "≡", color: "#9c9c9c" },
  bib: { label: "B", color: "#d4a017" },
  ris: { label: "RIS", color: "#d4a017" },
  png: { label: "▨", color: "#a074c4" },
  jpg: { label: "▨", color: "#a074c4" },
  jpeg: { label: "▨", color: "#a074c4" },
  gif: { label: "▨", color: "#a074c4" },
  webp: { label: "▨", color: "#a074c4" },
  svg: { label: "▨", color: "#a074c4" },
  pdf: { label: "PDF", color: "#e5534b" },
  docx: { label: "W", color: "#2b6cb0" },
  doc: { label: "W", color: "#2b6cb0" },
  xlsx: { label: "X", color: "#217346" },
  xlsm: { label: "X", color: "#217346" },
  xls: { label: "X", color: "#217346" },
  ods: { label: "X", color: "#217346" },
  csv: { label: "CSV", color: "#217346" },
  tsv: { label: "CSV", color: "#217346" },
  pptx: { label: "P", color: "#c43e1c" },
  ppt: { label: "P", color: "#c43e1c" },
  odp: { label: "P", color: "#c43e1c" },
};

function extOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** 按路径取文件类型图标；无扩展名或未收录类型返回 null */
export function fileTypeIcon(path: string): FileTypeIcon | null {
  const ext = extOf(path);
  return ext ? (EXT_ICONS[ext] ?? null) : null;
}

/** 文件树/预览可内嵌显示的图片（与 read_image_bytes 白名单一致） */
const PREVIEW_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function isPreviewableImagePath(path: string): boolean {
  const ext = extOf(path);
  return ext !== null && PREVIEW_IMAGE_EXTS.has(ext);
}
