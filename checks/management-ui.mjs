import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
test('UI: choose one missing case, explore only, rename, recycle and restore',{timeout:30000},async()=>{
 const calls=[],s={id:'suite1234',projectId:'p',name:'人员查询',moduleName:'人员管理',purpose:'边界回归',revision:3,updated:'v1',manifest:[{id:'TC-01',title:'查询'},{id:'TC-02',title:'重置'}],coverage:{complete:false,expected:2,generated:0},gaps:['定位不足']};
 const state={projects:[{id:'p',name:'GCS'}],plans:[],suites:[s],trash:{plans:[],suites:[]},jobs:[],workers:[],model:{configured:true},evidence:[{id:'e',projectId:'p',title:'当前页面',confirmed:true,capturedAt:new Date().toISOString()}]};
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw||'{}');
 if(req.url.startsWith('/api/')){calls.push({url:req.url,method:req.method,body});let result={ok:true};
 if(req.url==='/api/state')result=state;
 else if(req.url.endsWith('/missing'))result={missing:s.manifest,hash:'hash1',version:'v1',gaps:s.gaps};
 else if(req.url.endsWith('/metadata'))Object.assign(s,body);
 else if(req.method==='DELETE'){state.suites=[];state.trash.suites=[{...s,deletedAt:new Date().toISOString()}];}
 else if(req.url.endsWith('/restore')){state.suites=[s];state.trash.suites=[];}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;}
 const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'}[req.url];res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html');res.end(await readFile('public/'+file));
 }catch(e){res.statusCode=500;res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-zygote','--disable-gpu']}:{})});
 try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('button',{name:'测试脚本',exact:true}).click();await page.locator('.tree-module > summary').click();
 await page.getByRole('button',{name:'生成模块脚本',exact:true}).click();await page.getByLabel('TC-01 查询',{exact:true}).uncheck();await page.getByRole('button',{name:'提交所选操作',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
 assert.deepEqual(calls.find(x=>x.url.endsWith('/complete')).body.caseIds,['TC-02']);
 await page.getByRole('button',{name:'测试脚本',exact:true}).click();await page.locator('.tree-module > summary').click();await page.getByRole('button',{name:'生成模块脚本',exact:true}).click();await page.getByLabel('操作方式').selectOption('explore-gaps');await page.getByRole('button',{name:'提交所选操作',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.deepEqual(calls.find(x=>x.url.endsWith('/explore-gaps')).body.caseIds,['TC-01','TC-02']);
 await page.getByRole('button',{name:'测试脚本',exact:true}).click();await page.locator('.tree-module > summary').click();await page.getByRole('button',{name:'查看 / 编辑',exact:true}).click();await page.getByRole('button',{name:'标注 / 重命名',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('人员查询 · 仅边界');await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(s.name,'人员查询 · 仅边界');
 await page.locator('.tree-module > summary').click();await page.getByRole('button',{name:'查看 / 编辑',exact:true}).click();await page.getByRole('button',{name:'删除模块',exact:true}).click();await page.getByRole('button',{name:'确认移入回收站',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(state.suites.length,0);
 await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).last().click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(state.suites.length,1);assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
