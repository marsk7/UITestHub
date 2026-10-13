import {cases} from './case-scripts.mjs';
export function jobDisplay(kind,p={}){
 const labels={'complete-suite':'缺失用例补齐','explore-gaps':'用例缺口定向探索',planner:'测试计划生成',generator:'全量用例脚本生成',reporter:'执行结果分析',explore:'页面信息采集','regenerate-case':'单用例脚本重新生成'};
 let displayType=labels[kind]||kind,scopeLabel='',caseCount=null,caseTitle='';
 if(['run','validate'].includes(kind)){
  let items=[];try{items=cases(p.suite?.code||'');caseCount=items.length;}catch{}
  if(p.caseId!==undefined){caseCount=1;caseTitle=items.find(x=>x.id===String(p.caseId))?.title||'用例 '+p.caseId;displayType=kind==='validate'?'单用例试运行':'单用例正式执行';scopeLabel=caseTitle;}
  else{displayType=kind==='validate'?'整组脚本试运行':'整组脚本正式执行';scopeLabel=caseCount===null?'整组 · 数量未知':`整组 · ${caseCount} 条用例`;}
 }else if(['generator','complete-suite','explore-gaps'].includes(kind)){caseCount=p.manifest?.length??null;scopeLabel=caseCount===null?'历史任务 · 覆盖数量未知':`${kind==='generator'?'全部':'目标'} ${caseCount} 条用例：${(p.manifest||[]).map(x=>x.id).join('、')}`;}
 else if(kind==='regenerate-case'){caseCount=1;caseTitle=p.target?.title||'';scopeLabel=caseTitle;}
 if(p.liveValidation&&['generator','complete-suite'].includes(kind))displayType+=' + 逐用例浏览器验证';
 return{displayType,scopeLabel,caseCount,caseTitle,name:`${displayType} · ${p.suite?.name||p.name||'未命名'}${scopeLabel?' · '+scopeLabel:''}`,projectId:p.projectId};
}
