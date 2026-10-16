import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
import {explore} from '../src/explorer.mjs';
import {compactEvidence,mergeEvidence,locatorFromSpec,evidenceSignature} from '../src/locator-evidence.mjs';
import {checkScript} from '../src/script-check.mjs';

test('Select virtual a11y node is hidden; actual popup, collection columns and pagination remain replayable',{timeout:30000},async()=>{
 let queries=0;
 const server=http.createServer((req,res)=>{if(req.url==='/query'){queries++;return res.end('ok');}res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`
 <button onclick="document.querySelector('#filters').hidden=false">Expand</button>
 <section id="filters" hidden><div class="ant-form-item"><label>编制处室</label><div class="ant-select"><input id="division" role="combobox" aria-controls="division_list" aria-autocomplete="list" onclick="document.querySelector('#popup').hidden=false" oninput="document.querySelector('#target').hidden=this.value!=='虹桥机坪处'"><span class="ant-select-selection-item">浦东客运处</span></div></div></section>
 <div id="popup" class="ant-select-dropdown" hidden><div id="division_list" style="height:0;width:0;overflow:hidden"><div role="option" id="division_list_0" style="display:none">在职</div></div><div class="ant-select-item-option">浦东客运处</div><div class="ant-select-item-option" id="target" hidden><span class="ant-select-item-option-content">虹桥机坪处</span></div></div>
 <table id="staff"><thead><tr><th>任职状态</th><th>编制处室</th></tr></thead><tbody>${Array.from({length:6},()=>'<tr><td>在职</td><td>虹桥机坪处</td></tr>').join('')}</tbody></table>
 <ul class="ant-pagination"><li class="ant-pagination-total-text">1-6 of 26 items</li><li class="ant-pagination-item-active">1</li><li class="ant-pagination-next" title="Next Page"><button>Next</button></li><li><span class="ant-select-selection-item">6 / page</span></li></ul><button onclick="fetch('/query')">查询</button>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(join(tmpdir(),'component-evidence-'));
 const project={id:'p',baseURL:'http://127.0.0.1:'+server.address().port,entry:'/'};
 try{
  const e=await explore({project,dir,goals:{gaps:['「编制处室」下拉的选项「虹桥机坪处」没有候选']},agent:async({options})=>({actionKey:options.find(o=>o.actionType==='combobox'&&o.name==='编制处室')?.key})});
  assert.equal(queries,0);const target=e.controls.find(c=>c.kind==='select-option'&&c.nameHint==='虹桥机坪处'&&c.usable);assert.ok(target);assert.ok(target.prerequisites.some(p=>p.includes('.fill("虹桥机坪处")')));
  assert.ok(e.controls.some(c=>c.id==='division_list_0'&&!c.visible));
  const col=e.controls.find(c=>c.kind==='table-column'&&c.nameHint==='任职状态');assert.equal(col.candidates[0].count,6);assert.equal(col.candidates[0].visibleCount,6);assert.equal(col.candidates[0].kind,'collection');
  assert.equal(e.tables[0].rows.length,3);assert.equal(e.tables[0].visibleRowCount,6);assert.equal(e.tables[0].totalRows,null);
  assert.ok(e.controls.some(c=>c.kind==='selected-value'&&c.nameHint==='浦东客运处'));
  assert.ok(e.controls.some(c=>c.kind==='pagination-total'&&c.total===26));assert.ok(e.controls.some(c=>c.kind==='page-navigation'&&c.direction==='next'&&!c.disabled));
  const compact=compactEvidence(e);assert.ok(compact.tables.length);assert.equal(compact.controls.find(c=>c.kind==='table-column').candidates[0].kind,'collection');
  const collection=col.candidates[0].expression;assert.equal(checkScript(`test('x',async({page})=>{await page.${collection}.click();});`,e).ok,false);assert.equal(checkScript(`test('x',async({page})=>{await expect(page.${collection}).toHaveText(Array(6).fill('在职'));});`,e).ok,true);
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:JSON.parse(process.env.BROWSER_ARGS_JSON||'[]')}:{})});
  try{const page=await browser.newPage();await page.goto(project.baseURL);for(const action of target.prerequisites)await new Function('page','return '+action)(page);assert.equal(await locatorFromSpec(page,target.candidates[0].spec).count(),1);assert.equal(await locatorFromSpec(page,col.candidates[0].spec).count(),6);}finally{await browser.close();}
  assert.ok(mergeEvidence(e,{...e,controls:[],tables:[]}).tables.length);assert.notEqual(evidenceSignature(e),evidenceSignature({...e,tables:[]}));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('bounded virtual option scrolling records replay prerequisites without selecting business values',{timeout:30000},async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<div class="ant-select"><input id="status" role="combobox" aria-label="任职状态" aria-controls="status_list" readonly onclick="document.querySelector('#popup').hidden=false"></div><div id="popup" class="ant-select-dropdown" hidden><div id="status_list" hidden><div role="option">在职</div></div><div class="rc-virtual-list-holder" style="height:50px;overflow:auto" onscroll="document.querySelector('#option').textContent='离职'"><div style="height:300px"><div id="option" class="ant-select-item-option">在职</div></div></div></div>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=await mkdtemp(join(tmpdir(),'virtual-options-'));
 try{const e=await explore({project:{id:'p',baseURL:'http://127.0.0.1:'+server.address().port,entry:'/'},dir,maxSteps:4,goals:{gaps:['任职状态选项缺失']},agent:async()=>({actionKey:null})});
 const option=e.controls.find(c=>c.kind==='select-option'&&c.nameHint==='离职');assert.ok(option?.usable);assert.ok(option.prerequisites.some(a=>a.includes('scrollTop')));assert.ok(e.controls.some(c=>c.kind==='selected-value'&&c.owner==='status'&&c.emptySelection&&c.usable));assert.ok(e.actions.length<=4);assert.equal(e.actions.filter(a=>a.includes('.click()')).length,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
