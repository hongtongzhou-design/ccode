import type { HumanTaskStateDto, ProjectStepDto } from "./types";

/** 步骤内协同流程线（v3.71）的纯逻辑：把「这一步里人和 agent 的动作」按先后排成有序节点链，
 *  全部状态派生（无状态机）。节点顺序 = 讨论种子 → before 人工事项 → agent 执行
 *  → during 人工事项（并行段） → after 人工事项（v3.97 起一律进主干——收尾项是流程的一步，
 *  沉到可选分隔线下会让用户以为它不存在） → 评审合并。
 *  「当前节点」= 第一个未完成节点（currentNodeKey），组件高亮并就地展开其操作区；
 *  **可选人工事项不参与当前节点判定**——不做也能跑完，让它当「当前」会把指示卡死。
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
  kind: "discuss" | "input" | "human" | "agent" | "review";
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
  /** 项目当前的文献来源（input 节点完成口径）：非空且非 search = 已交代清楚 */
  litSource?: string;
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

  // 0.5 输入准备：文献从哪来（模板声明 asksLitSource 的步骤才有）。
  //     独立成节点、排在 agent 之前——它是**开工的前提**（决定 AI 要不要去检索），
  //     挂在 agent 节点内容区会让「开始」按钮出现在它上方，变成「先出发再问路」（用户实测）。
  if (step.asksLitSource) {
    nodes.push({
      key: "input",
      kind: "input",
      section: "main",
      label: "确定文献来源",
      hint: undefined,
      // 已声明来源（非默认 search）或已有登记资源 = 这一步交代清楚了
      done: (args.litSource ?? "").trim() !== "" && args.litSource !== "search",
    });
  }
  // 1. 「先定几件事」：**有东西要定才出现**（v3.89 修，用户反馈「有点空」）。
  //    v3.89 把整篇级决策移到项目层、把要看数据才能定的改为按需问之后，
  //    检索这类步骤的开工前决策项归零——节点只剩一个「跟 AI 商量」按钮，
  //    白占流程线一格还让人以为漏了什么。
  //    判定用**声明**（decisions/seeds 是否配置）而非「是否答完」：答完就消失会让
  //    流程线在你眼前少一格，比空着更让人不安。
  //    想法区（discussContent）随之改挂 agent 节点——它本来就是「开工前想清楚要干嘛」，
  //    贴着 agent 节点比单独占一格更贴切。
  const decisions = step.decisions ?? [];
  const seeds = step.discussionSeeds ?? [];
  const hasSomethingToSettle = decisions.length > 0 || seeds.length > 0;
  if (hasSomethingToSettle) {
    nodes.push({
      key: "discuss",
      kind: "discuss",
      section: "main",
      label:
        pendingDecisions > 0
          ? `先定几件事（还有 ${pendingDecisions} 件）`
          : "先定几件事",
      hint:
        pendingDecisions > 0
          ? "结论会写进 TASK.md"
          : undefined,
      done: hasDraft && pendingDecisions === 0,
    });
  }
  // 2. before 人工事项
  for (const h of humans("before")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: h.title,
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 3. agent 执行：完成 = 有待评审产出或已合并
  nodes.push({
    key: "agent",
    kind: "agent",
    section: "main",
    label: `AI 干活：${step.name}`,
    hint: undefined,
    done: runStatus === "review" || runStatus === "done",
  });
  // 4. during 人工事项（与 agent 并行段）
  for (const h of humans("during")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: h.optional ? "optional" : "main",
      label: h.title,
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 5. after 人工事项（agent 干完才轮到人）。
  //    v3.97 起**一律进主干**（用户拍板：「补充付费墙文献」这类收尾项就是流程的第三步，
  //    沉到可选分隔线下会让人觉得它不存在）；optional 的仍带「可选」徽标且不参与
  //    「当前节点」判定（见下方 currentKey），不会卡住流程指示
  for (const h of humans("after")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
      section: "main",
      label: h.title,
      hint: undefined,
      done: h.done,
      human: h,
    });
  }
  // 6. 评审合并（验收层是护城河：每步成果人工评审才合并）
  nodes.push({
    key: "review",
    kind: "review",
    section: "main",
    label: "你验收，合并进主文件夹",
    hint:
      runStatus === "review"
        ? "逐文件核对改动与产物，确认无误后提交并合并；有问题回终端继续修改"
        : runStatus === "active"
          ? "AI 提交产出后，回来核对并合并"
          : undefined,
    done: runStatus === "done",
  });

  // 当前节点只在主干里找，且跳过可选项：可选人工事项不做也能跑完这一步，
  // 让它当「当前」会把指示卡死在那儿，后面的节点永远轮不到
  const current = nodes.find(
    (n) =>
      n.section === "main" &&
      !n.done &&
      !(n.kind === "human" && n.human?.optional),
  );
  return { nodes, currentKey: current?.key ?? null };
}
