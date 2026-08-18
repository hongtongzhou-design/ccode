//! 终端输入侧纯逻辑：图片粘贴 / 文件拖入 / 右键菜单共用的可测函数（tests/terminal-input.test.ts）。

/** POSIX shell 安全字符：落进集合内的路径不包裹，直接写进终端更干净 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** shell 路径转义：含空格/引号/反斜杠等特殊字符时整体单引号包裹，单引号自身转 '\'' */
export function escapeShellPath(path: string): string {
  if (SHELL_SAFE.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** 拖入的多个路径转义后以空格拼接（不换行——只进输入框，避免直接执行） */
export function joinDroppedPaths(paths: string[]): string {
  return paths.filter((p) => p.length > 0).map(escapeShellPath).join(" ");
}

/** 剪贴板条目里挑出第一张图片（image/*），无图片返回 null（不干预默认文本粘贴） */
export function firstImageItem(
  items: readonly { type: string }[],
): number {
  return items.findIndex((it) => it.type.startsWith("image/"));
}

/** 图片 MIME → 落盘扩展名（白名单外的类型一律 png，与 Rust 端 save_clipboard_image 口径一致） */
export function imageExtFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** 粘贴图片成功后的轻反馈文案（名字太长截断，避免状态栏被路径撑爆） */
export function pasteImageFeedback(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return `已粘贴图片路径：${name.length > 40 ? `${name.slice(0, 37)}…` : name}`;
}
