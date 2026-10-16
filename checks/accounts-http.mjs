import {chromium} from '@playwright/test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {hashPassword,verifyPassword,canProject,accountInput} from '../src/access.mjs';
import {caseResults} from '../src/run-results.mjs';
import {mergeEvidence} from '../src/locator-evidence.mjs';
test('password hashing, malformed account data, old evidence and case results',async()=>{
 const h=await hashPassword('a-long-password');assert.ok(!h.includes('a-long-password'));assert.equal(await verifyPassword('a-long-password',h),true);assert.equal(await verifyPassword('wrong',h),false);assert.equal(await verifyPassword('x','broken'),false);await assert.rejects(hashPassword('short'));
 assert.throws(()=>accountInput({username:'ab',role:'admin'}));assert.equal(canProject({enabled:false,role:'admin'},'p'),false);
 const previous={projectId:'p',baseURL:'http://a',entry:'/',authSavedAt:'old',capturedAt:'2000-01-01',controls:[{nameHint:'old',candidates:[]}]};const current={...previous,authSavedAt:'new',controls:[{nameHint:'new',candidates:[]}]};assert.equal(mergeEvidence(previous,current).controls.length,2);
 const rows=caseResults({suites:[{title:'group',specs:[{id:'spec',title:'TC-01 查询',tests:[{projectName:'chromium',status:'unexpected',results:[{retry:0,status:'failed',errors:[{message:'not found'}]}]}]}]}]});assert.equal(rows[0].status,'failed');assert.deepEqual(rows[0].errors,['not found']);
});
test('real API: accounts, project isolation, readonly restrictions, cached evidence, report revocation',{timeout:45000},async()=>{
 const data=await mkdtemp(join(tmpdir(),'testhub-access-'));const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 for(const id of ['jp1','jp2']){await mkdir(join(data,'runs',id,'html-report'),{recursive:true});await writeFile(join(data,'runs',id,'html-report','index.html'),'<html>report</html>');await writeFile(join(data,'runs',id,'summary.json'),'{}');}
 const child=spawn(process.execPath,['--import','./checks/fixtures/http-loader.mjs','src/server.mjs'],{env:{...process.env,ADMIN_PASSWORD:'admin-password-123',DATA_DIR:data,PORT:String(port)},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',b=>output+=b);
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(output||'start timeout')),15000);child.stdout.on('data',b=>{if(String(b).includes('listening')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(new Error(output));});});
  const base='http://127.0.0.1:'+port;
  async function call(path,method='GET',body,cookie){const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const admin=(await call('/login','POST',{password:'admin-password-123'})).cookie;assert.ok(admin);
  const create=async(username,role,projectIds)=>{const r=await call('/users','POST',{username,displayName:username,role,projectIds,enabled:true,password:'user-password-123'},admin);assert.equal(r.status,201);assert.equal(r.data.passwordHash,undefined);return r.data;};
  const tester=await create('tester','tester',['p1']),viewer=await create('viewer','viewer',['p1']);
  const tc=(await call('/login','POST',{username:'tester',password:'user-password-123'})).cookie,vc=(await call('/login','POST',{username:'viewer',password:'user-password-123'})).cookie;
  const state=(await call('/state','GET',undefined,tc)).data;assert.deepEqual(state.projects.map(p=>p.id),['p1']);assert.deepEqual(state.jobs.map(j=>j.id),['jp1']);assert.equal(state.me.passwordHash,undefined);
  assert.equal((await call('/state','GET',undefined,admin)).data.projects.length,2);
  for(const url of ['/evidence/ep2','/suites/sp2/cases','/jobs/jp2','/jobs/jp2/artifacts','/jobs/jp2/download?file=summary.json','/jobs/jp2/preview?file=summary.json'])assert.equal((await call(url,'GET',undefined,tc)).status,404,url);
  for(const [url,body]of [['/runs',{suiteId:'sp2'}],['/jobs/jp2/cancel',{}],['/jobs/jp2/report-link',{}],['/plans',{projectId:'p2',name:'bad',content:'bad'}]])assert.equal((await call(url,'POST',body,tc)).status,404,url);
  assert.equal((await call('/users','GET',undefined,tc)).status,403);assert.equal((await call('/validate','POST',{suiteId:'sp1'},tc)).status,403);assert.equal((await call('/projects/p1/auth','POST',{},tc)).status,403);
  for(const url of ['/plans','/runs','/explore','/evidence/ep1/confirm'])assert.equal((await call(url,'POST',{},vc)).status,403,url);
  assert.equal((await call('/runs','POST',{suiteId:'sp1'},tc)).status,202);
  const confirmation=await call('/evidence/ep1/confirm','POST',{rules:'',selectedData:'[]'},tc);assert.equal(confirmation.status,200);assert.equal(confirmation.data.rules,'');
  const grant=await call('/jobs/jp1/report-link','POST',{},vc);assert.equal(grant.status,200);const reportURL=grant.data.url||grant.data.src;assert.ok(reportURL,JSON.stringify(grant.data));assert.equal((await fetch(base+reportURL)).status,200);
  const edit=await call('/users/'+viewer.id,'PATCH',{...viewer,projectIds:[],version:viewer.updated},admin);assert.equal(edit.status,200);assert.equal((await call('/state','GET',undefined,vc)).status,401);assert.equal((await fetch(base+reportURL)).status,401);
  const stale=await call('/users/'+viewer.id,'PATCH',{...viewer,version:viewer.updated},admin);assert.equal(stale.status,409);
  const adminRecord=(await call('/users','GET',undefined,admin)).data.find(u=>u.role==='admin');assert.equal((await call('/users/'+adminRecord.id,'PATCH',{...adminRecord,enabled:false,version:adminRecord.updated},admin)).status,400);
  assert.equal((await call('/me/password','POST',{oldPassword:'user-password-123',password:'new-password-123'},tc)).status,200);assert.equal((await call('/state','GET',undefined,tc)).status,401);assert.equal((await call('/login','POST',{username:'tester',password:'new-password-123'})).status,200);
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-zygote','--disable-gpu']}:{})});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
   await page.getByLabel('账号',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin-password-123');await page.getByRole('button',{name:'登录工作台'}).click();
   await page.getByRole('button',{name:'人员管理',exact:true}).click();await page.getByRole('button',{name:'＋ 添加账号'}).click();
   await page.getByLabel('账号',{exact:true}).fill('ui-reader');await page.getByLabel('姓名',{exact:true}).fill('界面创建账号');await page.getByLabel('初始密码').fill('reader-password-123');await page.getByLabel('角色').selectOption('viewer');await page.getByLabel('p2',{exact:true}).check();await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.getByText('界面创建账号 · ui-reader',{exact:true}).waitFor();await page.screenshot({path:'/tmp/testhub126-users.png',fullPage:true});
   await page.getByRole('button',{name:'退出登录'}).click();await page.locator('#login').waitFor({timeout:5000});await page.locator('#login').getByLabel('账号',{exact:true}).fill('ui-reader');await page.getByLabel('密码',{exact:true}).fill('reader-password-123');await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('button',{name:'项目与环境',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'人员管理',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'编辑项目',exact:true}).count(),0);assert.equal(await page.locator('.project-card').count(),1);assert.match(await page.locator('.project-card').innerText(),/p2/);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(data,{recursive:true,force:true});}
});
