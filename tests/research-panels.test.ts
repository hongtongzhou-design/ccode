import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { decisionGate, parseDecisions } from "../src/step-decisions.ts";

// Real React controls and Tauri calling code; only host IPC/store are replaced.
test("科研界面：摘要来源/缺失/截断、决定编辑撤回、复现确认与结果读取", async () => {
  const compiled = await build({ stdin: { contents: `export {createElement,act,useState} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Evidence} from './src/components/ResearchEvidencePanel'; export {default as Decisions} from './src/components/ResearchDecisionFields'; export {default as Reproduction} from './src/components/ResearchReproductionPanel'; export {ConfirmDialogHost} from './src/components/ConfirmDialog'; export {loadResearchReports} from './src/research-report-load';`, resolveDir: process.cwd(), loader: "tsx" },
    bundle:true,write:false,format:"cjs",platform:"node",jsx:"automatic",external:["react","react-dom/client","react/jsx-runtime"],plugins:[{name:"store",setup(b){
      b.onResolve({filter:/^\.\.\/store$/},()=>({path:"store",namespace:"stub"}));
      b.onLoad({filter:/.*/,namespace:"stub"},()=>({contents:"export const useAppStore = Object.assign(fn=>fn(globalThis.__researchStore),{getState:()=>globalThis.__researchStore});",loader:"js"}));
    }}] });
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
  const restore:Array<[string,PropertyDescriptor|undefined]>=[];
  const terminals: any[]=[];
  const state={runningScripts:{} as Record<string,string>,setPendingTerminal:(x:any)=>terminals.push(x),setPage:()=>{}};
  for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,requestAnimationFrame:(fn:()=>void)=>{fn();return 0;},cancelAnimationFrame:()=>{},sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true,__researchStore:state})){
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  let report='# Report\n## 验收摘要\n- 回答：<img src=x onerror="evil()">\n- 未决问题：缺全文\n- 质量状态：证据通过（自述）\n## Method\nnot summary';
  let truncated=false, scriptRevision='r1', fileError=false, rejectEnv=false, archived=false;
  let configured: {name:string;command:string;default:boolean}[] = [];
  const calls:string[]=[];
  let oldResolve: ((value: any) => void) | null = null;
  let mode = "normal";
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    calls.push(`${command}:${args.path??''}`);
    if(command==='read_file_preview'){
      assert.equal(args.requireWithinRoot,true);
      if(mode === "race" && args.path === "/old/report.md") return new Promise((resolve) => { oldResolve = resolve; });
      if(mode === "bounds" && args.path.endsWith("external.md")) return {text:"root external",truncated:false,revision:null,readOnlyReason:"符号链接指向项目外"};
      if(fileError)throw new Error('missing file');
      if(args.path.endsWith('reproduce.py'))return {text:'# MESA_REPRODUCE: {"interpreter":"python","subcommand":"reproduce","outputPlacement":"independent","resultFile":"verification.json"}\nadd_parser(\'reproduce\')',revision:scriptRevision,truncated:false};
      return {text:report,truncated,revision:truncated?null:'rev-report'};
    }
    if(command==='workspace_settings')return {runMode:'nonconcurrent',run:configured};
    if(command==='list_workspaces')return [{id:'w1',name:'exp-run',repoPath:'/project',worktreePath:'/tree',status:archived?'archived':'active'}];
    if(command==='workspace_env_for'){if(rejectEnv)throw new Error('env failure');return [['PORT','18000']];}
    if(command==='list_dir'){ assert.ok(args.root); return mode === 'bounds' ? Array.from({length:55},(_,i)=>({name:`r${i}.md`,isDir:false})) : []; }
    if(command==='research_run_reproduce'){
      assert.equal(args.subcommand,'reproduce');
      assert.equal(args.entry,'experiments/reproduce.py');
      return {id:'r-test',workspaceId:'w1',worktreePath:'/tree',command:['python3','experiments/reproduce.py','reproduce','--input','/tree','--output','/out'],entry:'experiments/reproduce.py',entryRevision:scriptRevision,input:'/tree',outputDir:'/out',status:'succeeded',exitCode:0,stdout:'',stderr:'',outputs:['verification.json'],resultFile:'verification.json',startedAt:'t0',finishedAt:'t1'};
    }
    if(command==='research_read_run_file'){
      assert.equal(args.path,'verification.json');
      return {text:'{"checks":"ok"}',truncated:false,revision:'out1'};
    }
    if(command==='research_get_run') throw new Error('no previous run');
    throw new Error('unexpected IPC '+command);
  }}});
  const mod={exports:{} as Record<string,any>};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
  const {createElement:h,act,useState,createRoot,Evidence,Decisions,Reproduction,ConfirmDialogHost,loadResearchReports}=mod.exports;
  const host=dom.window.document.getElementById('root')!;const root=createRoot(host);
  const allButtons=()=>Array.from(dom.window.document.querySelectorAll('button'));
  const button=(text:string)=>allButtons().find(b=>b.textContent===text)!;
  const input=async(el:HTMLInputElement|HTMLTextAreaElement,value:string)=>act(async()=>{
    const proto=el.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  });
  try{
    await act(async()=>root.render(h(Evidence,{root:'/project',patterns:['report.md'],kind:'acceptance'})));
    assert.match(host.textContent!,/缺全文/);assert.match(host.textContent!,/状态为报告自述/);
    assert.equal(host.querySelector('img'),null);
    assert.ok(button('查看原文：report.md'));
    await act(async()=>button('查看原文：report.md').click());assert.match(host.textContent!,/not summary/);
    await act(async()=>button('关闭原文').click());
    truncated=true;await act(async()=>button('刷新摘要').click());assert.match(host.textContent!,/不完整/);assert.match(host.textContent!,/文件截断/);
    report='# No summary';truncated=false;await act(async()=>button('刷新摘要').click());assert.match(host.textContent!,/未找到验收摘要/);
    fileError=true;await act(async()=>button('刷新摘要').click());assert.match(host.textContent!,/missing file/);fileError=false;
    mode = "race";
    await act(async()=>root.render(h(Evidence,{root:'/old',patterns:['report.md'],kind:'acceptance'})));
    report='# New\n## 验收摘要\n新项目摘要';
    await act(async()=>root.render(h(Evidence,{root:'/new',patterns:['report.md'],kind:'acceptance'})));
    assert.match(host.textContent!,/新项目摘要/);
    await act(async()=>oldResolve!({text:'# Old\n## 验收摘要\n旧项目不应出现',truncated:false,revision:'old'}));
    assert.doesNotMatch(host.textContent!,/旧项目不应出现/);
    const fallback = await loadResearchReports('/project', ['upstream.md'], 'decision');
    assert.equal(fallback.reports[0].sections[0].heading, '验收摘要', 'G4上游验收摘要可作为写作决定的依据，但不自动批准');
    mode = "bounds";
    const beforeLoad=calls.length;
    const limited=await loadResearchReports('/project',['notes/','../secret.md','external.md'],'acceptance');
    assert.ok(limited.scanned<=40);
    assert.ok(limited.warnings.some((w:string)=>w.includes('最多40')));
    assert.ok(!calls.slice(beforeLoad).some(x=>x.includes('../secret')));
    const external=await loadResearchReports('/project',['external.md'],'acceptance');
    assert.equal(external.reports.length,0);
    assert.match(external.warnings.join(' '),/符号链接/);
    mode = "normal";
    let task='## 已定方向\n\n- A：旧答案\n\n保留正文';
    function Form(){const [text,setText]=useState(task);return h(Decisions,{decisions:[{q:'A',options:[]}],text,onChange:(next:string)=>{task=next;setText(next);}});}
    await act(async()=>root.render(h(Form)));
    const status=host.querySelector('select')!;
    await act(async()=>{status.value='approve';status.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    const answer=host.querySelector('input')!;
    await input(answer,'方案 A ');assert.equal(answer.value,'方案 A ');
    assert.match(parseDecisions(task).get('A')!,/批准指定范围/);
    await input(answer,'');assert.equal(decisionGate({decisionMode:'hard_pause',decisions:[{q:'A',options:[]}]},task).blocked,true);assert.ok(task.includes('保留正文'));
    const props={workspace:{id:'w1',name:'exp-run',repoPath:'/project',worktreePath:'/tree',status:'active'},step:{name:'实验',workspaceName:'exp-run',brief:'',expectedArtifacts:['experiments/reproduce.py'],skills:[],run:[]},onLaunched:()=>{}};
    await act(async()=>root.render(h('div',null,h(Reproduction,props),h(ConfirmDialogHost))));
    assert.equal(terminals.length,0);
    assert.match(host.textContent!,/子命令 reproduce/);
    await act(async()=>button('运行这次复现').click());assert.equal(terminals.length,0);assert.match(dom.window.document.body.textContent!,/独立输出目录/);
    await act(async()=>button('取消').click());assert.equal(calls.filter(c=>c.startsWith('research_run_reproduce')).length,0);
    await act(async()=>button('运行这次复现').click());scriptRevision='r2';await act(async()=>button('确认运行').click());
    assert.match(host.textContent!,/入口已变化/);
    await act(async()=>button('刷新入口').click());
    await act(async()=>button('运行这次复现').click());await act(async()=>button('确认运行').click());
    assert.match(host.textContent!,/运行结束（退出码 0）/);
    assert.match(host.textContent!,/verification.json/);
    await act(async()=>button('本次输出：verification.json').click());
    assert.match(host.textContent!,/"checks":"ok"/);
    state.runningScripts.w1='other';
    await act(async()=>button('刷新入口').click());
    assert.ok(button('已有脚本运行中').disabled);
    delete state.runningScripts.w1;
    archived=true;
    await act(async()=>root.render(h('div',null,h(Reproduction,{...props,key:'archived',workspace:{...props.workspace,status:'archived'}}),h(ConfirmDialogHost))));
    assert.ok(button('运行这次复现').disabled);

  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,d]of restore){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});
