import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {missingCases,retryTargets,appendMissing,applyCompletion,generateWithRecovery} from '../src/suite-workflow.mjs';
import {explore} from '../src/explorer.mjs';
const manifest=Array.from({length:7},(_,i)=>({id:`TC-0${i+1}`,title:`用例 ${i+1}`}));
const block=t=>`test('${'['+t.id+'] '+t.title}',async({page})=>{await page.goto('/');await expect(page.getByText('标题')).toBeVisible();});`;
const code="import {test,expect} from '@playwright/test';\n// 保留已有公共代码\n"+manifest.slice(0,4).map(block).join('\n');
const suite={id:'suite',updated:'version1',code,manifest,revision:2,approved:true,validation:{status:'passed'},gaps:manifest.slice(4).map(x=>x.id+' '+x.title+'：缺少依据')};
test('only three missing cases are selectable; successful four are byte-preserved',()=>{
 assert.deepEqual(missingCases(suite),manifest.slice(4));assert.throws(()=>retryTargets(suite,['TC-01']),/已生成/);
 const result={code:manifest.slice(4).map(block).join('\n'),gaps:[],attemptedIds:manifest.slice(4).map(x=>x.id)};
 const saved=applyCompletion(suite,suite,result);assert.ok(saved.code.startsWith(code));assert.equal(saved.coverage.generated,7);assert.deepEqual(saved.gaps,[]);assert.equal(saved.revision,3);assert.equal(saved.approved,false);assert.equal(saved.validation,null);
 assert.throws(()=>appendMissing(code,block(manifest[0]),manifest),/覆盖/);
});
test('partial retry retains other missing gaps; concurrent edit/delete refuses overwrite',()=>{
 const result={code:block(manifest[4]),gaps:[],attemptedIds:['TC-05']};
 assert.deepEqual(applyCompletion(suite,suite,result).gaps,suite.gaps.slice(1));
 assert.throws(()=>applyCompletion({...suite,updated:'version2'},suite,result),/修改/);
 assert.throws(()=>applyCompletion({...suite,deletedAt:'now'},suite,result),/删除/);
});
test('automatic recovery explores once and retries only the blocked case',async()=>{
 const calls=[];let recovered=false,count=0;
 const result=await generateWithRecovery({manifest:manifest.slice(0,2),evidence:{controls:[]},autoExplore:true},{
  ask:async(_,p)=>{calls.push(p.target.id);return JSON.stringify(p.target.id==='TC-02'&&!recovered?{code:'',gaps:['缺少展开定位']}:{code:block(p.target),gaps:[]});},
  explore:async goals=>{assert.equal(goals.targets.length,1);count++;recovered=true;return{evidence:{controls:[],id:'new'},recommendations:['已实测展开按钮']};}
 });
 assert.deepEqual(calls,['TC-01','TC-02','TC-02']);assert.equal(count,1);assert.equal(result.coverage.complete,true);assert.equal(result.evidence.id,'new');
});
test('data or permission gaps do not trigger futile browser exploration',async()=>{
 let count=0;const result=await generateWithRecovery({manifest:manifest.slice(0,2),evidence:{controls:[]},autoExplore:true},{ask:async(_,p)=>JSON.stringify(p.target.id==='TC-02'?{code:'',gaps:['账号无权限']}:{code:block(p.target),gaps:[]}),explore:async()=>{count++;return{evidence:{controls:[]}};}});
 assert.equal(count,0);assert.equal(result.coverage.generated,1);assert.equal(result.gaps.length,1);assert.ok(result.code.includes('[TC-01]'));
});
test('Explorer observes real hidden control, records prerequisite, and rejects invented destructive action',{timeout:30000},async()=>{
 let submitted=0;const server=http.createServer((req,res)=>{if(req.url==='/delete'){submitted++;res.end('bad');return;}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><body><button aria-expanded="false" onclick="document.querySelector('#hidden').hidden=false;this.setAttribute('aria-expanded','true')">展开查询</button><button onclick="fetch('/delete')">删除</button><div id="hidden" hidden><label>工号<input id="staff"></label></div></body></html>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(join(tmpdir(),'explorer-agent-'));let rounds=0;
 try{const evidence=await explore({project:{id:'p',baseURL:'http://127.0.0.1:'+server.address().port,entry:'/'},dir,agent:async observation=>{
 rounds++;assert.ok(!observation.options.some(x=>x.name==='删除'));
 if(rounds===1){assert.equal(observation.controls.find(x=>x.nameHint==='工号').usable,false);return{actionKey:observation.options[0].key,suggestion:'尝试展开筛选'};}
 assert.equal(observation.controls.find(x=>x.nameHint==='工号').usable,true);return{actionKey:'button:删除',suggestion:'不应执行此操作'};
 }});
 assert.equal(rounds,2);assert.equal(submitted,0);assert.equal(evidence.actions.length,1);assert.ok(evidence.controls.some(c=>c.nameHint==='工号'&&c.usable&&c.prerequisites.length===1));assert.ok(evidence.warnings.some(x=>x.includes('未授权')));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
