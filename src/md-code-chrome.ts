/** 从 `language-ts` 这类 class 抽出围栏语言名。 */
export function languageFromCodeClass(className: string): string {
  const m = /(?:^|\s)language-([\w#+.-]+)/i.exec(className);
  return m?.[1] ?? "";
}

export function isMermaidLanguage(lang: string): boolean {
  return lang.trim().toLowerCase() === "mermaid";
}

/**
 * 给 marked 产出的 `pre > code` 套上头栏（语言名 + 复制）。
 * mermaid 围栏只打标，留给图渲染器。已装饰的跳过。
 */
export function decorateMdCodeBlocks(host: HTMLElement): void {
  const doc = host.ownerDocument;
  for (const code of host.querySelectorAll("pre > code")) {
    const pre = code.parentElement;
    if (!pre || pre.closest("[data-md-code]")) continue;
    const lang = languageFromCodeClass(code.className);
    if (isMermaidLanguage(lang)) {
      pre.setAttribute("data-md-mermaid", "1");
      continue;
    }
    const wrap = doc.createElement("div");
    wrap.setAttribute("data-md-code", "1");
    wrap.className = "md-code";
    const bar = doc.createElement("div");
    bar.className = "md-code-bar";
    const label = doc.createElement("span");
    label.className = "md-code-lang";
    label.textContent = lang || "code";
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "md-code-copy";
    btn.textContent = "⧉ 复制";
    bar.append(label, btn);
    pre.parentNode?.insertBefore(wrap, pre);
    wrap.append(bar, pre);
  }
}

/** 复制按钮点击：写入剪贴板并短暂改成「已复制」。 */
export function handleMdCodeCopyClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const btn = target.closest(".md-code-copy");
  if (!(btn instanceof HTMLButtonElement)) return false;
  const wrap = btn.closest("[data-md-code]");
  const code = wrap?.querySelector("pre > code");
  const text = code?.textContent ?? "";
  void navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "已复制";
    window.setTimeout(() => {
      if (btn.textContent === "已复制") btn.textContent = "⧉ 复制";
    }, 1200);
  }).catch(() => {});
  return true;
}
