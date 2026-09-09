import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { PIPELINE_TEMPLATES } from "../src/pipeline-presets.ts";

test("实际评审页接入本步骤摘要/未决项和复现；只读历史不运行", async () => {
  const bundle=await build({stdin:{contents:`export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {default as Review} from './src/components/WorkspaceReviewView';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react-dom/client','react/jsx-runtime'],plugins:[{name:'host',setup(b){
    b.onResolve({filter:/^\.\.\/store$/},()=>({path:'store',namespace:'stub'}));
    b.onResolve({filter:/^\.\/ArtifactChecklist$/},()=>({path:'artifacts',namespace:'stub'}));
    b.onResolve({filter:/^\.\/WatchRunReview$/},()=>({path:'watch',namespace:'stub'}));
    b.onLoad({filter:/.*/,namespace:'stub'},(args)=>({loader:'js',contents:args.path==='store'?'export const useAppStore=Object.assign(fn=>fn(globalThis.__reviewStore),{getState:()=>globalThis.__reviewStore});':args.path==='artifacts'?'export const loadArtifactRows=async()=>[];':'export default function Watch(){return null;}'}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
  const restore:Array<[string,PropertyDescriptor|undefined]>=[];
  for(const[key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true,__reviewStore:{setPage(){},setSelectProjectReq(){},setPendingTerminal(){throw new Error('no run expected');},runningScripts:{}}})){
    restore.push([key,Object.getOwnPropertyDescriptor(globalThis,key)]);Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  }
  let reviewOnly=false;
  const calls:string[]=[];
  const template=PIPELINE_TEMPLATES.find(t=>t.id==='research-paper')!,step=template.steps.find(s=>s.workspaceName==='exp-run')!;
  Object.assign(dom.window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
    calls.push(command);
    if(command==='workspace_diff')return {inWorkspace:true,workspaceId:'w',workspaceName:'exp-run',reviewOnly,baseBranch:'main',files:[],ahead:0,totalAdd:0,totalDel:0};
    if(command==='git_status')return {isRepo:true,branch:'ccode/test',ahead:0,behind:0,files:[],totalAdd:0,totalDel:0};
    if(command==='workspace_health')return {conflict:false,dirty:false,mainDirty:false,ahead:0,behind:0};
    if(command==='workspace_unmerged_files')return {merging:false,files:[],staleBase:false};
    if(command==='list_workspaces')return [{id:'w',name:'exp-run',status:'active',repoPath:'/project',worktreePath:'/tree',mergedAt:null}];
    if(command==='read_project_config')return {config:{steps:[step],resources:[]}};
    if(command==='check_citation_health')return {bibFound:true,totalRefs:1,resolved:1,missing:[]};
    if(command==='workspace_settings')return {run:[],runMode:'nonconcurrent'};
    if(command==='list_human_task_states'||command==='list_dir')return [];
    if(command==='research_get_acceptance')return null;
    if(command==='research_get_run')throw new Error('no run');
    if(command==='read_file_preview'){
      assert.equal(args.root,'/tree');assert.equal(args.requireWithinRoot,true);
      return args.path.endsWith('.py')?{text:'print("test")',revision:'script',truncated:false}:{text:'# 实验结果\n## 验收摘要\n- 回答：执行记录齐全\n- 未决问题：独立复算待完成\n- 质量状态：待审\n## 实验\n正文',revision:'report',truncated:false};
    }
    throw new Error(command);
  }}});
  const module={exports:{} as Record<string,any>};new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const{createElement:h,act,createRoot,Review}=module.exports;
  const host=dom.window.document.getElementById('root')!,root=createRoot(host);
  try{
    await act(async()=>root.render(h(Review,{worktreePath:'/tree',onClose(){}})));
    assert.match(host.textContent!,/验收摘要与未决项/);assert.match(host.textContent!,/独立复算待完成/);assert.match(host.textContent!,/基础检查/);
    assert.match(host.textContent!,/复现运行/);assert.match(host.textContent!,/科研验收决定/);
    assert.ok(!calls.some(c=>['shell_spawn','pty_write','merge_workspace'].includes(c)), '打开评审不会执行代码或合并');
    reviewOnly=true;
    await act(async()=>root.render(h(Review,{key:'history',worktreePath:'/history',onClose(){}})));
    assert.doesNotMatch(host.textContent!,/复现运行/);
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,d]of restore){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}
});
