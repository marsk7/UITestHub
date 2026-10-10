import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {explore} from '../src/explorer.mjs';
import {checkScript,checkEvidence} from '../src/script-check.mjs';
const code="import {test,expect} from '@playwright/test'; test('query',async({page})=>{await page.goto('/');await expect(page.getByRole('button',{name:'查询'})).toBeVisible();});";
test('script checks and evidence mismatch gates',()=>{
 assert.equal(checkScript(code).ok,true);assert.equal(checkScript(code.replace('查询','Expand'),{controls:[]}).ok,false);assert.equal(checkScript(code+' test.skip("x",()=>{});').ok,false);assert.equal(checkScript('test(').ok,false);assert.equal(checkScript('import fs from "node:fs";'+code).ok,false);
 const p={id:'p',baseURL:'http://fixture',entry:'/'},e={projectId:'p',baseURL:p.baseURL,entry:'/',confirmed:true,capturedAt:new Date().toISOString()};checkEvidence(e,p);assert.throws(()=>checkEvidence({...e,confirmed:false},p));assert.throws(()=>checkEvidence(e,{...p,authSavedAt:'new'}));assert.throws(()=>checkEvidence({...e,capturedAt:'2000-01-01'},p));
});
test('exploration checks locators and bounded rows without querying; login wall',{timeout:60000},async()=>{
 let queryCount=0;const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');if(req.url==='/query'){queryCount++;return res.end('queried');}if(req.url==='/login')return res.end('<input type="password">');res.end(`<label for="name">姓名</label><input id="name"><button onclick="fetch('/query')">查询</button><button>重置</button><button onclick="document.querySelector('#extra').hidden=false">展开</button><div id="extra" hidden><label>工号<input id="number"></label></div><table><thead><tr><th>工号</th><th>姓名</th></tr></thead><tbody>${Array.from({length:6},(_,i)=>'<tr><td>E00'+i+'</td><td>员工'+i+'</td></tr>').join('')}</tbody></table>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(path.join(os.tmpdir(),'explore-'));const project={id:'fixture',baseURL:'http://127.0.0.1:'+server.address().port,entry:'/'};
 try{
  const a=await explore({project,dir});assert.ok(a.controls.some(c=>c.label==='姓名'&&c.usable));assert.ok(a.controls.some(c=>c.nameHint==='展开'&&c.usable));assert.ok(!a.controls.some(c=>c.nameHint==='Expand'));assert.equal(a.tables[0].rows.length,3);assert.equal(a.controls.find(c=>c.id==='number').visible,false);assert.equal(queryCount,0);assert.ok((await readFile(path.join(dir,'page.png'))).length>100);
  const b=await explore({project,dir,expand:true});assert.equal(b.controls.find(c=>c.id==='number').visible,true);assert.equal(b.actions.length,1);assert.equal(queryCount,0);
  await assert.rejects(explore({project:{...project,entry:'/login'},dir}),/登录/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
