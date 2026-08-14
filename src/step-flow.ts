import type { HumanTaskStateDto, ProjectStepDto } from "./types";

/** 步骤内协同流程线（v3.71）的纯逻辑：把「这一步里人和 agent 的动作」按先后排成有序节点链，
 *  全部状态派生（无状态机）。节点顺序 = 讨论种子 → before 人工事项 → agent 执行
 *  → during 人工事项（并行段） → after 人工事项 → 评审合并。
 *  「当前节点」= 第一个未完成节点（currentNodeKey），组件高亮并就地展开其操作区。
 *  例外：agent 节点的「开始/恢复工作区/去终端看看」不受当前节点门控——开始始终可用，
 *  讨论种子与开始前事项只提醒不拦（同 KickoffConfirmDialog 口径）。 */

/** 步骤执行状态的外部输入（由调用方从工作区派生：ProjectGroup 的 deriveStepStatus 口径） */
export type StepRunStatus =
  | "pending" // 未开始（无工作区或已归档）
  | "active" // agent 进行中
  | "review" // agent 做完了待评审（含阻塞——阻塞也走评审入口）
  | "done"; // 已合并

export interface StepFlowNode {
  key: string;
  kind: "discuss" | "human" | "agent" | "review";
  /** 版式分区：main = 主干（必须发生的先后链）；optional = 可选补充（沉到分隔线下）。
   *  可选项不进主干还有个要紧的副作用——它们不再抢「当前节点」：
   *  一个永远不打勾的可选项会把当前指示卡死在那儿，后面的节点永远轮不到 */
  section: "main" | "optional";
  label: string;
  /** 引导小字（落点说明/时机说明） */
  hint?: string;
  done: boolean;
  /** human 节点对应的人工事项（勾选/提交产物回传用） */
  human?: HumanTaskStateDto;
}

export interface StepFlow {
  nodes: StepFlowNode[];
  /** 第一个未完成节点的 key；全部完成为 null */
  currentKey: string | null;
}

export function buildStepFlow(args: {
  step: ProjectStepDto;
  /** 本步骤的人工事项派生状态（已按步骤过滤） */
  states: HumanTaskStateDto[];
  /** 本步骤任务书草稿已起草（.ccode/drafts/<步骤>.md，讨论种子节点的完成口径） */
  hasDraft: boolean;
  runStatus: StepRunStatus;
  /** 还没拍板的决策项数量（草稿「已定方向」小节回填后算出）：
   *  只要还有没答的，本节点就不算完事——只写了一条答案草稿就存在了，
   *  拿 hasDraft 当完成口径会在还剩几题没答时就打勾 */
  pendingDecisions?: number;
}): StepFlow {
  const { step, states, hasDraft, runStatus } = args;
  const pendingDecisions = args.pendingDecisions ?? 0;
  const nodes: StepFlowNode[] = [];
  const humans = (timing: string) => states.filter((s) => s.timing === timing);

  // 1. 定方向：恒存在。它同时是想法区的落点（discussContent），
  //    没有决策项也没有种子的步骤照样要能记想法、聊任务书——按「有种子才生成」会让那些步骤
  //    的想法区整个消失。无可拍板项时直接算完成，不挡后面的节点。
  const decisions = step.decisions ?? [];
  const seeds = step.discussionSeeds ?? [];
  const nothingToSettle = decisions.length === 0 && seeds.length === 0;
  nodes.push({
    key: "discuss",
    kind: "discuss",
    section: "main",
    label:
      pendingDecisions > 0
        ? `定方向：还有 ${pendingDecisions} 件要拍板`
        : "定方向：本步任务书",
    hint:
      pendingDecisions > 0
        ? "选项点一下就答完，不用开会话；拿不准的点「其他…」自己写或开聊"
        : undefined,
    done: nothingToSettle || (hasDraft && pendingDecisions === 0),
  });
  // 2. before 人工事项
  for (const h of humans("before")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: h.title,
      hint: h.target ? `交付落点 ${h.target}` : "完成后手动勾选",
      done: h.done,
      human: h,
    });
  }
  // 3. agent 执行：完成 = 有待评审产出或已合并
  nodes.push({
    key: "agent",
    kind: "agent",
    section: "main",
    label: `agent 执行：${step.name}`,
    hint:
      runStatus === "pending"
        ? "点「开始」建工作区并开工"
        : runStatus === "active"
          ? "agent 正在工作区里干活"
          : runStatus === "review"
            ? "agent 做完了，产物待你评审"
            : "已合并",
    done: runStatus === "review" || runStatus === "done",
  });
  // 4. during 人工事项（与 agent 并行段）
  for (const h of humans("during")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: h.title,
      hint: `agent 干活期间随时可做${h.target ? `；交付落点 ${h.target}` : ""}`,
      done: h.done,
      human: h,
    });
  }
  // 5. after 人工事项（agent 干完才轮到人）
  for (const h of humans("after")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: h.title,
      hint: `agent 干完后轮到你${h.target ? `；交付落点 ${h.target}` : ""}`,
      done: h.done,
      human: h,
    });
  }
  // 6. 评审合并（验收层是护城河：每步成果人工评审才合并）
  nodes.push({
    key: "review",
    kind: "review",
    section: "main",
    label: "评审合并进主文件夹",
    hint: runStatus === "review" ? "点「去评审」验收产物" : undefined,
    done: runStatus === "done",
  });

  // 当前节点只在主干里找：可选项不做也能往下走，让它当「当前」会把指示卡死
  const current = nodes.find((n) => n.section === "main" && !n.done);
  return { nodes, currentKey: current?.key ?? null };
}
