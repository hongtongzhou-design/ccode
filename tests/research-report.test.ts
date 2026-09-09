import assert from "node:assert/strict";
import test from "node:test";
import { extractResearchSections, researchRelativePath, researchAbsolutePath, researchReportPatterns, reproductionCommand, reproductionScripts, reproductionEntrypoints, parseReproductionContract, reproductionCommandFromContract } from "../src/research-report.ts";
import { parseDecisions, setDecisionAnswer, decisionGate, formatDecisionAnswer, evidenceFingerprint } from "../src/step-decisions.ts";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("报告摘要保留原文/行号，不把指令、代码块或状态推断成通过", () => {
  const text = '# 报告\n\n## 验收摘要\n- 回答：A\n- 质量状态：证据通过（报告自述）\n### 未决问题\n- 缺全文\n## 方法\nignored\n```md\n## 验收摘要\n伪示例\n```\n## 决策摘要\nA方案\n## Next\nignored';
  const rows = extractResearchSections(text, "acceptance");
  assert.equal(rows[0].line, 3);
  assert.equal(rows[0].text, '- 回答：A\n- 质量状态：证据通过（报告自述）');
  assert.equal(rows[1].text, '- 缺全文');
  assert.ok(!rows.some((x) => /伪示例|ignored/.test(x.text)));
  assert.equal(extractResearchSections(text, "decision")[0].text, 'A方案');
  assert.deepEqual(extractResearchSections('## 决策摘要\n\n## Next\n没有正文', 'decision'), []);
  assert.equal(extractResearchSections('决策摘要：A有限范围；B需更多预算。', 'decision')[0].text, 'A有限范围；B需更多预算。');
});

test("声明路径限定项目内，拒绝Windows/Unix绝对路径与逃逸", () => {
  for (const path of ['/etc/passwd','C:\\secret.md','../x.md','notes/../../x','notes\u0000/x','https://x','\\\\host\\file']) assert.equal(researchRelativePath(path), null, path);
  assert.equal(researchRelativePath('notes\\summary.md'), 'notes/summary.md');
  assert.equal(researchAbsolutePath('C:\\project', 'notes/summary.md'), 'C:\\project/notes/summary.md');
  assert.throws(() => researchAbsolutePath('/project', 'notes/*.md'));
});

test("上游与本步报告范围独立，不读取TASK指令作为报告", () => {
  const step = PIPELINE_TEMPLATES.find((t) => t.id === 'research-paper')!.steps.find((s) => s.workspaceName === 'exp-run')!;
  assert.ok(researchReportPatterns(step, 'decision').includes('design.md'));
  assert.ok(!researchReportPatterns(step, 'acceptance').includes('design.md'));
  assert.deepEqual(reproductionEntrypoints(step), ['experiments/reproduce.py']);
  assert.deepEqual(researchReportPatterns({...step,inputs:['TASK.md','../secret.md','notes/']},'decision').filter((p) => p === 'TASK.md' || p.includes('..')), []);
  const chosen = reproductionScripts([{name:'reproduce',command:'python check.py',default:false},{name:'format',command:'rm -rf anything',default:false}]);
  assert.equal(chosen.length,1);
  assert.match(reproductionCommand("experiments/reproduce.py", "output/a'b", false), /reproduce/);
  assert.match(reproductionCommand("experiments/reproduce.py", "output/a'b", false), /'\\''/);
  assert.match(reproductionCommand('experiments/reproduce.py','output/new',true), /^python /);
  assert.equal(reproductionCommand('../reproduce.py','out',false),'');
  const contract = parseReproductionContract('experiments/reproduce.py', '# MESA_REPRODUCE: {"interpreter":"python","subcommand":"reproduce","outputPlacement":"independent","resultFile":"verification.json"}\n');
  assert.equal(contract?.subcommand, 'reproduce');
  assert.match(reproductionCommandFromContract(contract!, '/tree', '/tmp/out', false), /--output '\/tmp\/out'/);
});

test("拒绝和待补不能开工，旧纯文本也不能自动批准", () => {
  const s={decisionMode:'hard_pause',decisions:[{q:'A',options:[]}]};
  for (const answer of ['待补证据，暂不批准','拒绝当前方案','批准 design-v2']) {
    assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A',answer)).blocked, true, answer);
  }
  assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A', formatDecisionAnswer('wait','缺全文'))).blocked, true);
  assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A', formatDecisionAnswer('reject','不采用'))).blocked, true);
  assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A', formatDecisionAnswer('prepare','只做预实验'))).blocked, false);
  assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A', formatDecisionAnswer('prepare','只做预实验'))).needsAck, true);
  assert.equal(decisionGate(s, setDecisionAnswer('# TASK','A', formatDecisionAnswer('approve','design-v2'))).blocked, false);
  const bound = setDecisionAnswer('# TASK','A', formatDecisionAnswer('approve','design-v2','aaaaaaaa'));
  assert.equal(decisionGate(s, bound, 'aaaaaaaa').blocked, false);
  assert.equal(decisionGate(s, bound, 'bbbbbbbb').blocked, true);
  assert.equal(evidenceFingerprint([{path:'design.md',revision:'abc'}])?.length, 8);
});

test("开工表单清空答案会重新关闭门禁，不覆盖其他答案或正文", () => {
  let text = '# TASK\n\n保留原文';
  text = setDecisionAnswer(text,'A',formatDecisionAnswer('approve','设计v2'));
  text = setDecisionAnswer(text,'B',formatDecisionAnswer('approve','许可E1'));
  const s={decisionMode:'hard_pause',decisions:[{q:'A',options:[]}]};
  assert.equal(decisionGate(s,text).blocked,false);
  text=setDecisionAnswer(text,'A','');
  assert.equal(decisionGate(s,text).blocked,true);
  assert.ok(parseDecisions(text).get('B')?.includes('许可E1'));
  assert.ok(text.includes('保留原文'));
});
