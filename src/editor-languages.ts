import type * as monaco from "monaco-editor";

/**
 * LaTeX 语法高亮（批次 E）：monaco-editor 0.56 的内置语言表不含 latex
 * （VS Code 的 LaTeX 高亮来自扩展的 TextMate 语法，monaco 未收录），
 * 因此自带一份紧凑 Monarch 定义注册为 latex 语言，覆盖 .tex/.sty/.cls/.bib。
 * 只求常用可读（注释/命令/环境/公式/括号），不追求完整 TeX 文法。
 */

export const LATEX_LANGUAGE_ID = "latex";
export const LATEX_EXTENSIONS = [".tex", ".sty", ".cls", ".bib"];

export const latexMonarch: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/%.*$/, "comment"],
      [/\\(?:begin|end)\b/, "keyword"],
      [/\\[a-zA-Z@]+\*?/, "keyword"],
      [/\\./, "keyword"],
      [/\$\$/, { token: "string", next: "@mathDisplay" }],
      [/\$/, { token: "string", next: "@mathInline" }],
      [/[{}[\]()]/, "@brackets"],
    ],
    mathInline: [
      [/\\./, "keyword"],
      [/\$/, { token: "string", next: "@pop" }],
      [/[^$\\]+/, "string"],
    ],
    mathDisplay: [
      [/\\./, "keyword"],
      [/\$\$/, { token: "string", next: "@pop" }],
      [/[^$\\]+/, "string"],
    ],
  },
};

/** 按文件扩展名/文件名在已注册语言表里找匹配（FilePreviewEditor.languageFor 的纯逻辑部分） */
export interface LangDefLike {
  id: string;
  filenames?: string[];
  extensions?: string[];
}

export function matchLanguageByPath(
  langs: readonly LangDefLike[],
  path: string,
): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  for (const lang of langs) {
    if (lang.filenames?.includes(name)) return lang.id;
    if (ext && lang.extensions?.includes(ext)) return lang.id;
  }
  return undefined;
}
