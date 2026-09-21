/** 预览阅读版式覆盖的 Markdown 族：笔记 / 技能 / Quarto / MDX。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx|qmd)$/i.test(path);
}

/** HTML 预览默认走沙箱渲染，可切回源码。 */
export function isHtmlPath(path: string): boolean {
  return /\.(html|htm)$/i.test(path);
}
