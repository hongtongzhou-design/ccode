import type { HumanTaskStateDto, ProjectStepDto } from "./types";

/** 步骤内协同流程线（v3.71）的纯逻辑：把「这一步里人和 agent 的动作」按先后排成有序节点链，
 *  全部状态派生（无状态机）。节点顺序 = 讨论种子 → before 人工事项 → agent 执行
 *  → during 人工事项（并行段） → after 人工事项 → 评审合并。
 *  「当前节点」= 第一个未完成节点（currentNodeKey），组件高亮并就地展开其操作区。 */

/** 步骤执行状态的外部输入（由调用方从工作区派生：ProjectGroup 的 deriveStepStatus 口径） */
export type StepRunStatus =
  | "pending" // 未开始（无工作区或已归档）
  | "active" // agent 进行中
  | "review" // agent 做完了待评审（含阻塞——阻塞也走评审入口）
  | "done"; // 已合并

export interface StepFlowNode {
  key: string;
  kind: "discuss" | "human" | "agent" | "review";
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
}): StepFlow {
  const { step, states, hasDraft, runStatus } = args;
  const nodes: StepFlowNode[] = [];
  const humans = (timing: string) => states.filter((s) => s.timing === timing);

  // 1. 讨论种子（有种子才有此节点）：聊透 = 任务书草稿已起草
  if ((step.discussionSeeds ?? []).length > 0) {
    nodes.push({
      key: "discuss",
      kind: "discuss",
      label: "任务书：和 Agent 聊出本步任务书",
      hint: "讨论出的结论直接写进草稿，开工时草稿就是 TASK.md",
      done: hasDraft,
    });
  }
  // 2. before 人工事项
  for (const h of humans("before")) {
    nodes.push({
      key: `human:${h.title}`,
      kind: "human",
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
    label: "评审合并进主文件夹",
    hint: runStatus === "review" ? "点「去评审」验收产物" : undefined,
    done: runStatus === "done",
  });

  const current = nodes.find((n) => !n.done);
  return { nodes, currentKey: current?.key ?? null };
}
