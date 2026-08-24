//! 聊天消息里的图片路径识别纯逻辑（tests/chat-image.test.ts）。
//! 粘贴/拖拽图片后，会话文件里记下的就是一行路径文本（终端粘贴还会带 shell 单引号包裹）——
//! 渲染层据此把「整行是图片路径」的行从正文剥离，换成内嵌图片卡。

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
/** http(s) 等 URL 不是本地路径（外链图片按惯例不加载） */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 一行文本是否是本地图片路径：绝对路径（/、~/、盘符）或含分隔符的相对路径，
 *  且以图片扩展名结尾；允许 shell 单引号包裹（escapeShellPath 的产物）。
 *  裸文件名（无分隔符）不识别——无法和正文短语区分。命中返回剥离引号后的路径。 */
export function imagePathFromLine(line: string): string | null {
  const t = line.trim();
  if (!t || URL_SCHEME.test(t)) return null;
  // 剥 shell 单引号包裹（含 '\'' 回转）
  const unquoted =
    t.length > 1 && t.startsWith("'") && t.endsWith("'")
      ? t.slice(1, -1).replace(/'\\''/g, "'")
      : t;
  if (!IMAGE_EXT.test(unquoted)) return null;
  const isAbs =
    unquoted.startsWith("/") ||
    unquoted.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(unquoted);
  const hasSep = unquoted.includes("/") || unquoted.includes("\\");
  return isAbs || hasSep ? unquoted : null;
}

/** 把消息文本拆成「正文 + 图片路径行」：整行是图片路径的行按出现顺序抽进 images，
 *  其余行拼回正文并去掉首尾空行。 */
export function splitImagePaths(text: string): {
  text: string;
  images: string[];
} {
  const images: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const p = imagePathFromLine(line);
    if (p) images.push(p);
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), images };
}
