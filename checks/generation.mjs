import test from 'node:test';
import assert from 'node:assert/strict';
import {planManifest,confirmManifest,assertionPolicy,coverageOf,generateAll} from '../src/generation.mjs';
import {jobDisplay} from '../src/job-display.mjs';
const manifest=Array.from({length:7},(_,i)=>({id:'TC-0'+(i+1),title:'场景 '+(i+1)}));
const content=manifest.map(x=>'### '+x.id+' '+x.title).join('\n');
const payload={manifest,plan:{content},evidence:{controls:[]},assertionPolicy:assertionPolicy({mode:'alternatives',alternatives:'TC-03：姓名不能为空 | 请输入姓名'})};
const codeFor=t=>`test(${JSON.stringify('['+t.id+'] '+t.title)},async({page})=>{await page.goto('/');await expect(page.getByText('人员管理')).toBeVisible();});`;
test('inventory requires explicit confirmation, rejects omissions/duplicates and retains seven cases',()=>{
 assert.deepEqual(planManifest(content),manifest);
 assert.equal(planManifest('| TC-01 | 默认状态 |').length,1);
 assert.equal(confirmManifest(manifest.map(x=>x.id+' '+x.title).join('\n'),content,true).length,7);
 assert.throws(()=>confirmManifest('TC-01 场景 1',content,true),/遗漏/);
 assert.throws(()=>confirmManifest('TC-01 一\nTC-01 二','',true),/重复/);
 assert.throws(()=>confirmManifest('TC-01 一','',false),/确认/);
 assert.throws(()=>assertionPolicy({mode:'alternatives'}),/等价文案/);
});
test('generation attempts all seven independently and passes confirmed assertion policy',async()=>{
 const seen=[];const result=await generateAll(payload,{ask:async(system,p)=>{seen.push(p.target.id);assert.equal(p.assertionPolicy.alternatives,payload.assertionPolicy.alternatives);assert.match(system,/PRD 明确/);assert.match(system,/隐藏文字不算通过/);return JSON.stringify({code:codeFor(p.target),gaps:[]});}});
 assert.deepEqual(seen,manifest.map(x=>x.id));assert.equal(result.coverage.generated,7);assert.equal(result.coverage.complete,true);assert.deepEqual(result.gaps,[]);assert.equal(result.staticCheck.ok,true);
});
test('malformed, blocked and wrong-case responses remain missing while later cases are generated',async()=>{
 const seen=[];const result=await generateAll(payload,{ask:async(_,p)=>{seen.push(p.target.id);if(p.target.id==='TC-02')return '{broken';if(p.target.id==='TC-03')return JSON.stringify({code:'',gaps:['缺少数据']});if(p.target.id==='TC-04')return JSON.stringify({code:codeFor(manifest[0]),gaps:[]});return JSON.stringify({code:codeFor(p.target),gaps:[]});}});
 assert.equal(new Set(seen).size,7);assert.equal(seen.length,9);assert.equal(result.coverage.generated,4);assert.equal(result.coverage.complete,false);assert.equal(result.gaps.length,3);assert.equal(result.coverage.rows.at(-1).status,'generated');
});
test('coverage rejects missing, duplicate and unplanned declarations',()=>{
 const code=manifest.map(codeFor).join('\n');assert.equal(coverageOf(code,manifest).complete,true);
 assert.equal(coverageOf(code+'\n'+codeFor(manifest[0]),manifest).complete,false);
 assert.equal(coverageOf(code+"\ntest('unexpected',()=>{});",manifest).complete,false);
 assert.equal(coverageOf(codeFor(manifest[0]),manifest).generated,1);
});
test('cancellation stops further model calls',async()=>{
 let calls=0;await assert.rejects(generateAll(payload,{cancelled:async()=>calls>=1,ask:async(_,p)=>{calls++;return JSON.stringify({code:codeFor(p.target),gaps:[]});}}),/取消/);assert.equal(calls,1);
});
test('execution metadata distinguishes single, suite, formal and regeneration without credentials',()=>{
 const p={projectId:'p',name:'人员管理',suite:{name:'人员管理',code:manifest.map(codeFor).join('\n')},storageState:{cookies:['secret']}};
 assert.equal(jobDisplay('validate',p).displayType,'整组脚本试运行');assert.equal(jobDisplay('validate',p).caseCount,7);
 const single=jobDisplay('validate',{...p,caseId:'2'});assert.equal(single.displayType,'单用例试运行');assert.equal(single.caseTitle,'[TC-03] 场景 3');assert.equal(single.caseCount,1);
 assert.equal(jobDisplay('run',p).displayType,'整组脚本正式执行');assert.equal(jobDisplay('regenerate-case',{target:{title:'TC-01'}}).caseCount,1);
 assert.ok(!JSON.stringify(single).includes('secret'));assert.match(jobDisplay('generator',{}).scopeLabel,/历史任务/);
});
