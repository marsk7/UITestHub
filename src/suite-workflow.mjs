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
 return {...suite,...merged,gaps,staticCheck:checkScript(merged.code),revision:(suite.revision||1)+(merged.code!==suite.code?1:0),approved:false,validation:null,caseValidations:{},lastGenerationAt:new Date().toISOString()};
}
// One bounded recovery round per task. Only missing cases are retried.
export async function generateWithRecovery(payload,deps){
 let result=await generateAll(payload,deps),evidence=payload.evidence,exploration=null;
 const missing=result.coverage.rows.filter(x=>x.status==='missing');
 if(payload.autoExplore&&missing.length&&deps.explore){
  await deps.progress?.('发现生成缺口，启动 Explorer 定向探索（最多 3 步，完成后仅重试缺失用例一次）…\n');
  try{
   exploration=await deps.explore({targets:missing,gaps:result.gaps});
   evidence=exploration.evidence;
   const retry=await generateAll({...payload,manifest:missing,evidence},deps);
   const merged=appendMissing(result.code,retry.code,payload.manifest);
   result={...merged,gaps:retry.gaps,staticCheck:checkScript(merged.code,evidence)};
  }catch(e){if(await deps.cancelled?.())throw e;result.gaps.push('Explorer：'+e.message);}
 }
 return{...result,evidence,exploration,attemptedIds:payload.manifest.map(x=>x.id)};
}
