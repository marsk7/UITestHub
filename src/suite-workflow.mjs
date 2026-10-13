import {evidenceSignature} from './locator-evidence.mjs';
import {validationSummary} from './generation-verifier.mjs';
import {cases} from './case-scripts.mjs';
import {coverageOf,generateAll} from './generation.mjs';
import {codeHash,checkScript} from './script-check.mjs';
const fail=m=>{throw Object.assign(new Error(m),{status:409});};
export function missingCases(suite){
 if(!suite.manifest?.length)fail('旧脚本没有完整用例清单，请从测试计划重新生成');
 const coverage=coverageOf(suite.code,suite.manifest);
 if(coverage.unexpected.length||coverage.rows.some(x=>x.status==='duplicate'))fail('请先修正重复或未计划的用例编号');
 return coverage.rows.filter(x=>x.status==='missing').map(({id,title})=>({id,title}));
}
export function retryTargets(suite,ids){
 const missing=missingCases(suite);if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)fail('请选择需要补齐的用例');
 if(ids.some(id=>!missing.some(x=>x.id===id)))fail('选中的用例已生成或不在缺失清单中，请刷新');
 return missing.filter(x=>ids.includes(x.id));
}
export function appendMissing(base,generated,manifest){
 const before=coverageOf(base,manifest);let items=[];
 if(generated.trim()){try{items=cases(generated);}catch(e){if(checkScript(generated).tests)throw e;}}
 for(const c of items){const target=manifest.find(x=>c.title===`[${x.id}] ${x.title}`);if(!target)fail('补齐结果包含未指定的用例');if(before.rows.find(x=>x.id===target.id)?.count)fail('不能覆盖已经存在的用例');}
 const code=base+(items.length?'\n\n'+items.map(x=>x.code).join('\n\n'):'');
 const coverage=coverageOf(code,manifest);if(coverage.rows.some(x=>x.status==='duplicate'))fail('补齐结果包含重复用例');
 return{code,coverage};
}
export function applyCompletion(suite,snapshot,result){
 if(suite.deletedAt||suite.updated!==snapshot.updated||codeHash(suite.code)!==codeHash(snapshot.code))fail('脚本在补齐期间已修改或删除，请刷新后重试');
 const merged=appendMissing(suite.code,result.code,suite.manifest);
 const missing=new Set(merged.coverage.rows.filter(x=>x.status==='missing').map(x=>x.id));
 const attempted=new Set(result.attemptedIds||[]);
 const prior=(suite.gaps||[]).filter(g=>!suite.manifest.some(x=>g.startsWith(x.id+' ')&&(!missing.has(x.id)||attempted.has(x.id))));
 const gaps=[...prior,...result.gaps];
 const rows=[...(suite.generationVerification?.rows||[]).filter(r=>!attempted.has(r.id)),...(result.generationVerification?.rows||[])];
 return {...suite,...merged,generationVerification:{rows,summary:validationSummary(rows)},gaps,blockers:[...(suite.blockers||[]).filter(b=>missing.has(b.id)&&!attempted.has(b.id)),...(result.blockers||[])],staticCheck:checkScript(merged.code),revision:(suite.revision||1)+(merged.code!==suite.code?1:0),approved:false,validation:null,caseValidations:{},lastGenerationAt:new Date().toISOString()};
}
// Bounded retries stop on success, unchanged evidence, cancellation or the round limit.
export async function generateWithRecovery(payload,deps){
 let result=await generateAll(payload,deps),evidence=payload.evidence,exploration=null;
 const history=[],limit=Math.max(1,Math.min(3,Number(payload.explorationRounds)||2));
 for(let round=1;payload.autoExplore&&deps.explore&&round<=limit;round++){
  const missing=result.coverage.rows.filter(x=>x.status==='missing');if(!missing.length)break;
  if(result.blockers?.length&&result.blockers.every(x=>x.category!=='locator')){await deps.progress?.('剩余缺口属于数据、业务规则或模型格式；不重复点击页面。请按缺口补充后重试。\n');break;}
  await deps.progress?.(`启动 Explorer 第 ${round}/${limit} 轮定向探索，再尝试缺失用例…\n`);
  try{
   const previous=evidenceSignature(evidence);
   exploration=await deps.explore({targets:missing,gaps:result.gaps,locatorNotes:payload.locatorNotes||'',round,maxSteps:payload.explorationSteps||6,previousActions:history.flatMap(x=>x.actions||[]),priorEvidence:evidence});
   evidence=exploration.evidence;history.push({evidenceId:exploration.evidenceId,actions:exploration.actions||[],recommendations:exploration.recommendations||[]});
   const retry=await generateAll({...payload,manifest:missing,evidence,previousGaps:result.gaps},deps);
   const merged=appendMissing(result.code,retry.code,payload.manifest);
   const rows=[...(result.generationVerification?.rows||[]).filter(r=>!missing.some(m=>m.id===r.id)),...(retry.generationVerification?.rows||[])];
   result={...merged,generationVerification:{rows,summary:validationSummary(rows)},gaps:retry.gaps,blockers:retry.blockers,staticCheck:checkScript(merged.code,evidence)};
   if(previous===evidenceSignature(evidence)){await deps.progress?.('本轮没有新增或变化的定位依据，停止重复探索；仍缺失的用例保留具体原因。\n');break;}
  }catch(e){if(await deps.cancelled?.())throw e;result.gaps.push('Explorer：'+e.message);break;}
 }
 return{...result,evidence,exploration:exploration?{...exploration,history}:null,attemptedIds:payload.manifest.map(x=>x.id)};
}
