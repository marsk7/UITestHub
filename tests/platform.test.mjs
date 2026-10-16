import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=path.resolve('.');
if(!/^testhub_test_[a-zA-Z0-9_]+$/.test(process.env.DB_NAME||''))throw new Error('Set DB_NAME to a dedicated testhub_test_* database. Never use the application DB.');
const {pool,query,init}=await import('../src/db.mjs');
await init();
for(const table of ['records','jobs','workers'])if((await query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n)throw new Error('Test database must be empty.');
if((await query("SHOW TABLES LIKE 'users'")).length&&(await query('SELECT COUNT(*) AS n FROM users'))[0].n)throw new Error('Test database users table must be empty.');
await pool.end();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('authenticated workflow, approval gates, model jobs, queue cancellation and real browser execution',{timeout:150000},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'testhub-test-')),port=await freePort(),url=`http://127.0.0.1:${port}`,password='integration-secret-123456';
 const model=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const q=JSON.parse(b),system=q.messages[0].content;let text='# 测试计划\n### TC-01 默认页面标题';if(system.includes('TypeScript'))text="test('[TC-01] 默认页面标题',async({page})=>{await page.goto('/demo');await expect(page.getByRole('heading')).toHaveText('人员管理');});";if(system.includes('分析师'))text='结果分析：依据已提供的实际统计，测试已完成；产品根因仍需人工确认。';if(system.includes('TypeScript'))text=JSON.stringify({code:text,gaps:[]});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:text}}]}));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
 const env={...process.env,ADMIN_PASSWORD:password,PORT:String(port),DATA_DIR:dir,LLM_BASE_URL:`http://127.0.0.1:${model.address().port}/v1`,LLM_MODEL:'test-stub',DEMO_BASE_URL:url};
 const children=[];let logs='';const start=file=>{const c=spawn(process.execPath,[file],{cwd:root,env,stdio:['ignore','pipe','pipe']});c.stdout.on('data',b=>logs+=b);c.stderr.on('data',b=>logs+=b);children.push(c);return c;};start('src/server.mjs');
 t.after(async()=>{for(const c of children)c.kill('SIGTERM');await sleep(800);for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');await new Promise(r=>model.close(r));await rm(dir,{recursive:true,force:true});});
 for(let i=0;i<60;i++){try{if((await fetch(url+'/health')).ok)break;}catch{}await sleep(100);}
 let cookie='';async function req(p,method='GET',data,expected=200,extra={}){const r=await fetch(url+'/api'+p,{method,headers:{'Content-Type':'application/json',Cookie:cookie,...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b)+'\n'+logs);return b;}
 await req('/state','GET',undefined,401);
 await req('/login','POST',{password:'wrong'},401);
 const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
 let state=await req('/state');const project=state.projects[0],suite=state.suites[0];
 await req('/runs','POST',{suiteId:suite.id},400);
 await req('/projects','POST',{name:'Bad',baseURL:'javascript:alert(1)'},400);
 await req('/projects','POST',{name:'X',baseURL:url},403,{Origin:'https://attacker.invalid'});
 await req('/suites/'+suite.id+'/approve','POST',{});
 await req('/suites/'+suite.id,'PUT',{name:suite.name,code:suite.code});
 await req('/runs','POST',{suiteId:suite.id},400);
 await req('/suites/'+suite.id+'/approve','POST',{});
 const beforeDelete=await req('/runs','POST',{suiteId:suite.id},202);
 await req('/suites/'+suite.id,'DELETE',{},409);
 await req('/jobs/'+beforeDelete.id+'/cancel','POST',{});
 await req('/suites/'+suite.id,'DELETE',{});
 let recycled=await req('/state');assert.ok(!recycled.suites.some(x=>x.id===suite.id));assert.ok(recycled.trash.suites.some(x=>x.id===suite.id));
 await req('/runs','POST',{suiteId:suite.id},404);
 await req('/suites/'+suite.id+'/restore','POST',{});await req('/suites/'+suite.id+'/approve','POST',{});
 const cancelled=await req('/runs','POST',{suiteId:suite.id},202);await req('/jobs/'+cancelled.id+'/cancel','POST',{});assert.equal((await req('/jobs/'+cancelled.id)).status,'cancelled');
 start('src/worker.mjs');
 async function waitJob(id){for(let i=0;i<180;i++){const j=await req('/jobs/'+id);if(!['queued','running'].includes(j.status))return j;await sleep(500);}throw new Error('Job timeout '+logs);}
 const pj=await req('/planner','POST',{projectId:project.id,name:'Mock model plan',requirement:'查询姓名，返回精确匹配结果'},202);const pjob=await waitJob(pj.id);assert.equal(pjob.status,'succeeded',pjob.log);const pid=pjob.result.planId;
 await req('/generator','POST',{planId:pid,context:'label 姓名'},400);await req('/plans/'+pid+'/approve','POST',{});
 const ex=await req('/explore','POST',{projectId:project.id},202);assert.equal(ex.payload,undefined);const explored=await waitJob(ex.id);assert.equal(explored.status,'succeeded',explored.log);const eid=explored.result.evidenceId;
 await req('/generator','POST',{planId:pid,evidenceId:eid},409);
 await req('/evidence/'+eid+'/confirm','POST',{rules:'页面标题为人员管理；姓名模糊查询，重置清空条件',selectedData:'王晓，E001；仅使用演示数据'});
 const inventory=await req('/plans/'+pid+'/manifest');
 const generationRequest={planId:pid,evidenceId:eid,planVersion:inventory.planVersion,manifestText:inventory.manifest.map(x=>x.id+' '+x.title).join('\n'),manifestConfirmed:true,assertionPolicy:{mode:'business'}};
 await req('/generator','POST',{...generationRequest,liveValidation:true},400);
 const gj=await req('/generator','POST',{...generationRequest,liveValidation:process.env.RUN_BROWSER_TESTS==='1',executionConfirmed:true},202);const g=await waitJob(gj.id);assert.equal(g.status,'succeeded',g.log);
 if(process.env.RUN_BROWSER_TESTS==='1'){assert.equal(g.result.generationVerification.summary.passed,1);const nested=await req('/jobs/'+g.id+'/report-link','POST',{reportPath:'verify-TC-01/html-report'});assert.equal((await fetch(url+nested.url)).status,200);}
 state=await req('/state');assert.equal(state.suites.find(x=>x.id===g.result.suiteId).approved,false);
 await req('/suites/'+g.result.suiteId+'/approve','POST',{},400);
 const generatedSuite=state.suites.find(x=>x.id===g.result.suiteId);
 await req('/suites/'+generatedSuite.id+'/metadata','PATCH',{name:'人员查询 · 回归',moduleName:'人员管理',purpose:'补齐验收',version:generatedSuite.updated});
 await req('/suites/'+generatedSuite.id,'PUT',{name:'人员查询 · 回归',code:"import {test,expect} from '@playwright/test';"});
 const missing=await req('/suites/'+generatedSuite.id+'/missing');assert.equal(missing.missing.length,1);
 await req('/suites/'+generatedSuite.id+'/complete','POST',{baseHash:'stale',version:missing.version,caseIds:['TC-01']},409);
 const completion=await req('/suites/'+generatedSuite.id+'/complete','POST',{baseHash:missing.hash,version:missing.version,caseIds:['TC-01'],autoExplore:false},202);
 assert.equal(completion.payload,undefined);const completed=await waitJob(completion.id);assert.equal(completed.status,'succeeded',completed.log);assert.equal(completed.result.coverage.generated,1);
 assert.equal((await req('/suites/'+generatedSuite.id+'/missing')).missing.length,0);

 if(process.env.RUN_BROWSER_TESTS==='1'){
 const validation=await req('/validate','POST',{suiteId:g.result.suiteId,confirmed:true},202);assert.equal(validation.payload,undefined);const validated=await waitJob(validation.id);assert.equal(validated.status,'passed',validated.log);await req('/suites/'+g.result.suiteId+'/approve','POST',{});
 const r=await req('/runs','POST',{suiteId:suite.id},202);const run=await waitJob(r.id);assert.equal(run.status,'passed',run.log);assert.equal(run.result.passed,3);assert.equal(run.result.total,3);
 const artifacts=await req('/jobs/'+r.id+'/artifacts');assert.ok(artifacts.some(x=>x.name==='results.json'));assert.ok(artifacts.some(x=>x.name==='artifacts.zip'));assert.ok(!artifacts.some(x=>x.name.includes('storage.json')));
 await req('/jobs/'+r.id+'/download?file=../testhub.db','GET',undefined,403);
 const report=await fetch(url+'/api/jobs/'+r.id+'/download?file=results.json',{headers:{Cookie:cookie}});assert.equal(report.status,200);assert.ok(report.headers.get('content-disposition').startsWith('attachment'));
 const online=await req('/jobs/'+r.id+'/report-link','POST',{});const html=await fetch(url+online.url);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/sandbox/);assert.ok(!html.headers.get('content-security-policy').includes('allow-same-origin'));
 const preview=await req('/jobs/'+r.id+'/preview?file=summary.json');assert.equal(JSON.parse(preview.text).passed,3);
 const aj=await req('/jobs/'+r.id+'/analyze','POST',{},202);assert.equal((await waitJob(aj.id)).status,'succeeded');
 const bad=await req('/suites','POST',{projectId:project.id,name:'Deliberate assertion failure',code:"import {test,expect} from '@playwright/test';test('failure evidence',async({page})=>{await page.goto('/demo');await expect(page.getByRole('heading')).toHaveText('Wrong title',{timeout:500});});"},201);await req('/suites/'+bad.id+'/approve','POST',{});const bj=await req('/runs','POST',{suiteId:bad.id},202);const failed=await waitJob(bj.id);assert.equal(failed.status,'failed',failed.log);assert.equal(failed.result.failed,1);const evidence=await req('/jobs/'+bj.id+'/artifacts');assert.ok(evidence.some(x=>x.name.endsWith('trace.zip')));assert.ok(evidence.some(x=>x.name.endsWith('.png')));

 const skippedSuite=await req('/suites','POST',{projectId:project.id,name:'Skip is not pass',code:"import {test} from '@playwright/test'; test.skip('missing evidence',async()=>{});"},201);await req('/suites/'+skippedSuite.id+'/approve','POST',{});const sj=await req('/runs','POST',{suiteId:skippedSuite.id},202);assert.equal((await waitJob(sj.id)).status,'error');
 const slow=await req('/suites','POST',{projectId:project.id,name:'Cancellation check',code:"import {test} from '@playwright/test'; test('long running',async()=>{await new Promise(r=>setTimeout(r,60000));});"},201);await req('/suites/'+slow.id+'/approve','POST',{});const cj=await req('/runs','POST',{suiteId:slow.id},202);for(let i=0;i<30;i++){if((await req('/jobs/'+cj.id)).status==='running')break;await sleep(100);}await req('/jobs/'+cj.id+'/cancel','POST',{});assert.equal((await waitJob(cj.id)).status,'cancelled');
 // UI checks exercise sign-in, project edit dialog and responsive overflow.
 const {chromium}=await import('@playwright/test');const browser=await chromium.launch(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:JSON.parse(process.env.BROWSER_ARGS_JSON||'[]')}:{});try{const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.getByLabel('管理员密码').fill(password);await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('heading',{name:'工作概览'}).waitFor();await page.getByRole('button',{name:'项目与环境',exact:true}).click();await page.getByRole('button',{name:'编辑项目'}).click();await page.getByLabel('项目名称').fill('示例项目 · 已更新');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('heading',{name:'示例项目 · 已更新'}).waitFor();await page.getByRole('button',{name:'工作概览',exact:true}).click();await page.screenshot({path:process.env.SCREENSHOT_PATH||'/tmp/testhub-overview.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);}finally{await browser.close();}
 }
 console.log('Verified auth, CSRF, approval invalidation, persistent queue, cancellation, mocked AI plan/generation'+(process.env.RUN_BROWSER_TESTS==='1'?', 3 real passing browser tests, failure trace/screenshot, report download, mocked analysis and desktop/mobile UI':''));
});
