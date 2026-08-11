import type { TaskCardDto } from "./types";

/** 任务卡纯逻辑：分桶/排序/简报定位，供工作区页卡片区、对话页分组与评审沉淀共用（单一出处，测试在 tests/task-cards.test.ts） */

/** 卡片排序：创建时间升序（先建在前），同刻按名称字典序兜底，保证渲染顺序稳定 */
export function sortCards(cards: TaskCardDto[]): TaskCardDto[] {
  return cards
    .slice()
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name),
    );
}

/** 按流水线步骤分桶：步骤桶按流水线顺序排列；挂在已删除/改名步骤上的卡与未挂步骤的卡
 *  一起收进「未挂步骤」桶（恒在末尾，即使为空也保留——它是新建未挂卡片的入口） */
export function bucketCardsByStep(
  cards: TaskCardDto[],
  stepNames: string[],
): { step: string | null; cards: TaskCardDto[] }[] {
  const sorted = sortCards(cards);
  const buckets = stepNames.map((step) => ({
    step: step as string | null,
    cards: [] as TaskCardDto[],
  }));
  const unattached: { step: string | null; cards: TaskCardDto[] } = {
    step: null,
    cards: [],
  };
  for (const card of sorted) {
    const bucket =
      card.step !== null
        ? buckets.find((b) => b.step === card.step)
        : undefined;
    (bucket ?? unattached).cards.push(card);
  }
  return [...buckets, unattached];
}

/** 卡片最新定稿简报（briefs 按时间序，末位最新）；无简报返回 null */
export function latestBrief(card: TaskCardDto): string | null {
  return card.briefs.length > 0 ? card.briefs[card.briefs.length - 1] : null;
}

/** 步骤的默认沉淀卡片：挂在该步骤的第一张卡（sortCards 序）；无则 null（调用方就地新建） */
export function cardForStep(
  cards: TaskCardDto[],
  stepName: string,
): TaskCardDto | null {
  return sortCards(cards).find((c) => c.step === stepName) ?? null;
}

/** 简报文件名里的落盘时间（.ccode/brief-<yyyyMMddTHHmmssZ>[-N].md）→ ISO UTC 字符串；
 *  解析失败（手动改名等）返回 null，调用方省略时间展示 */
export function briefTimeFromPath(relPath: string): string | null {
  const m = /brief-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?\.md$/.exec(
    relPath,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** 会话按卡片分组（对话页项目筛选下）：「未归置」(taskId null) 恒在最前，与原「无工作区会话排最前」同口径；
 *  其余组按组内最近活跃降序；组内保持传入顺序（调用方已按时间降序）。
 *  组名取组内首个非空 taskName（后端按项目回填，卡片删除后 taskId/taskName 均为 null） */
export function groupSessionsByTask<
  T extends {
    taskId: string | null;
    taskName: string | null;
    updatedAt: string | null;
  },
>(sessions: T[]): { taskId: string | null; name: string; list: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const s of sessions) {
    const k = s.taskId;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      if (a[0] === null) return -1;
      if (b[0] === null) return 1;
      return (b[1][0]?.updatedAt ?? "").localeCompare(a[1][0]?.updatedAt ?? "");
    })
    .map(([taskId, list]) => ({
      taskId,
      name:
        taskId === null
          ? "未归置"
          : (list.find((s) => s.taskName)?.taskName ?? "未命名卡片"),
      list,
    }));
}
