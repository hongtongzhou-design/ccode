/** TASK.md「文献来源」段的单一出处：模板拼装（renderTaskMd）与就地同步（upsert）共用。
 *  独立成纯模块（不依赖 tauri API），供 node --test 直接覆盖。 */

/** 「文献来源」段的正文行。search/空 = 无此段（从零系统检索是默认行为，不必写进 TASK.md）。
 *  文献来自已有库时检索步骤的性质变了——不是「去检索」而是「盘点 + 查漏」，
 *  放在简报之前，让 agent 先知道前提再读步骤简报（模板简报本身不必为此写两套） */
export function litSourceSectionLines(
  litSource: string | undefined,
): string[] | null {
  const v = litSource?.trim();
  if (v !== "zotero" && v !== "folder") return null;
  return [
    "## 文献来源",
    v === "zotero"
      ? "本项目的文献来自用户已有的 Zotero 库（已导出 references.bib，PDF 见「项目资源」段的绝对路径）。"
      : "本项目的文献来自用户已有的本地文件夹（见「项目资源」段）。",
    "因此涉及文献检索的步骤按「盘点 + 查漏补缺」执行，而不是从零系统检索：",
    "1. 先通读已有条目，按本步骤的纳入/排除标准逐条判定，产出筛选记录；",
    "2. 只针对明显缺口做补充检索（近一年新工作、标准里要求但库中没有的方向），不重复已有条目；",
    "3. 已有条目的元数据以 references.bib 为准，不要重新编造；缺字段标「待补」。",
  ];
}

/** 把「文献来源」段就地同步进已有 TASK.md 内容（v3.90）：内容文件一旦被编辑/播种就是快照，
 *  项目配置里改文献来源不再自动反映——这段是改变检索步骤性质的硬前提，必须跟着配置走。
 *  有段替换、无段插入（优先「已定方向」/「预期产物」之前，与 renderTaskMd 相对位置一致；都没有则补到末尾）、
 *  search 时删除该段。无变化时原样返回（调用方据此判断是否写盘）。 */
export function upsertLitSourceSection(text: string, litSource: string): string {
  const lines = text.split("\n");
  // 已有段的行区间 [start, end)：到下一个「## 」小节或文末
  const start = lines.findIndex((l) => l.trim() === "## 文献来源");
  let end = -1;
  if (start >= 0) {
    end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        end = i;
        break;
      }
    }
  }
  const section = litSourceSectionLines(litSource);
  if (!section) {
    if (start < 0) return text;
    lines.splice(start, end - start);
    return lines.join("\n");
  }
  if (start >= 0) {
    lines.splice(start, end - start, ...section, "");
    return lines.join("\n");
  }
  let at = lines.findIndex(
    (l) => l.startsWith("## 已定方向") || l.startsWith("## 预期产物"),
  );
  if (at < 0) at = lines.length;
  lines.splice(at, 0, ...section, "");
  return lines.join("\n");
}
