import {chromium} from '@playwright/test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {hashPassword,verifyPassword,canProject,accountInput,permitRoute,requireExecution} from '../src/access.mjs';
import {caseResults} from '../src/run-results.mjs';
import {mergeEvidence} from '../src/locator-evidence.mjs';
test('password hashing, malformed account data, old evidence and case results',async()=>{
 const h=await hashPassword('a-long-password');assert.ok(!h.includes('a-long-password'));assert.equal(await verifyPassword('a-long-password',h),true);assert.equal(await verifyPassword('wrong',h),false);assert.equal(await verifyPassword('x','broken'),false);await assert.rejects(hashPassword('short'));
 assert.throws(()=>accountInput({username:'ab',role:'admin'}));assert.equal(canProject({enabled:false,role:'admin'},'p'),false);
 const ownViewer={id:'v',enabled:true,role:'viewer',projectIds:['assigned'],ownedProjectIds:['own']};assert.doesNotThrow(()=>permitRoute(ownViewer,'POST','/api/validate','own'));assert.throws(()=>permitRoute(ownViewer,'POST','/api/validate','assigned'));assert.doesNotThrow(()=>requireExecution(ownViewer,'own'));assert.throws(()=>requireExecution(ownViewer,'assigned'));assert.throws(()=>permitRoute(ownViewer,'POST','/api/users','own'));
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
  // Self-registration cannot choose admin or grant itself unrelated projects.
  assert.equal((await call('/register','POST',{username:'owner',displayName:'项目创建者',password:'12345'})).status,400);
  assert.equal((await call('/register','POST',{username:'owner',displayName:'项目创建者',password:'123456',role:'admin',projectIds:['p2']})).status,201);
  assert.equal((await call('/register','POST',{username:'owner',displayName:'重复',password:'123456'})).status,409);
  const oc=(await call('/login','POST',{username:'owner',password:'123456'})).cookie;
  const fresh=(await call('/state','GET',undefined,oc)).data;assert.equal(fresh.me.role,'tester');assert.deepEqual(fresh.projects,[]);
  const created=await call('/projects','POST',{name:'自建项目',baseURL:base,entry:'/demo',ownerId:adminRecord.id},oc);assert.equal(created.status,201);const own=created.data;assert.equal(own.ownerId,fresh.me.id);
  assert.equal((await call('/projects/'+own.id,'PUT',{name:'自建项目更新',baseURL:base,entry:'/demo',ownerId:adminRecord.id},oc)).data.ownerId,fresh.me.id);
  assert.equal((await call('/state','GET',undefined,oc)).data.projects.length,1);assert.equal((await call('/users','GET',undefined,oc)).status,403);
  assert.equal((await call('/projects/p2','PUT',{name:'越权',baseURL:'http://fixture'},oc)).status,403);
  const ls=await call('/projects/'+own.id+'/login-session','POST',{},oc);assert.equal(ls.status,201,JSON.stringify(ls.data));assert.equal((await call('/login-sessions/'+ls.data.id+'/frame','GET',undefined,admin)).status,403);
  assert.equal((await call('/login-sessions/'+ls.data.id+'/save','POST',{confirmed:true},oc)).status,200);
  const ownSuite=(await call('/suites','POST',{projectId:own.id,name:'自建脚本',code:"import {test,expect} from '@playwright/test'; test('TC-01 标题',async({page})=>{await page.goto('/');});"},oc)).data;
  assert.equal((await call('/validate','POST',{suiteId:ownSuite.id,confirmed:true},oc)).status,202);
  assert.equal((await call('/suites/'+ownSuite.id+'/approve','POST',{},oc)).status,200);
  assert.equal((await call('/runs','POST',{suiteId:ownSuite.id},oc)).status,202);
  const plan=(await call('/plans','POST',{projectId:own.id,name:'人员模块',content:'### TC-01 查询\n### TC-02 重置'},oc)).data;
  await call('/plans/'+plan.id+'/approve','POST',{},oc);const manifest=(await call('/plans/'+plan.id+'/manifest','GET',undefined,oc)).data;
  const module=await call('/modules','POST',{planId:plan.id,planVersion:manifest.planVersion,name:'人员模块',manifestConfirmed:true,manifestText:'TC-01 查询\nTC-02 重置'},oc);assert.equal(module.status,201);assert.equal(module.data.coverage.expected,2);assert.equal(module.data.coverage.generated,0);
  assert.equal((await call('/plans/'+plan.id,'PUT',{name:'冲突修改',content:'不应覆盖',version:'stale-version'},oc)).status,409);
  const os=(await call('/state','GET',undefined,oc)).data;assert.ok(os.me.ownedProjectIds.includes(own.id));assert.equal(os.suites.find(x=>x.id===module.data.id).caseInventory.length,2);
  assert.equal((await call('/suites/'+module.data.id+'/cases','GET',undefined,admin)).status,200); // Empty module remains manageable before generation.
  assert.equal((await call('/suites/'+module.data.id+'/missing','GET',undefined,vc)).status,401);
  assert.ok((await call('/state','GET',undefined,admin)).data.projects.some(p=>p.id===own.id));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-zygote','--disable-gpu']}:{})});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
   await page.getByLabel('账号',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill('admin-password-123');await page.getByRole('button',{name:'登录工作台'}).click();
   await page.getByRole('button',{name:'人员管理',exact:true}).click();await page.getByRole('button',{name:'＋ 添加账号'}).click();
   await page.getByLabel('账号',{exact:true}).fill('ui-reader');await page.getByLabel('姓名',{exact:true}).fill('界面创建账号');await page.getByLabel('初始密码').fill('reader-password-123');await page.getByLabel('角色').selectOption('viewer');await page.getByLabel('p2',{exact:true}).check();await page.getByRole('button',{name:'保存',exact:true}).click();
   await page.getByText('界面创建账号 · ui-reader',{exact:true}).waitFor();await page.screenshot({path:'/tmp/testhub126-users.png',fullPage:true});
   await page.getByRole('button',{name:'退出登录'}).click();await page.locator('#login').waitFor({timeout:5000});await page.locator('#login').getByLabel('账号',{exact:true}).fill('ui-reader');await page.getByLabel('密码',{exact:true}).fill('reader-password-123');await page.getByRole('button',{name:'登录工作台'}).click();await page.getByRole('button',{name:'项目与环境',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'人员管理',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'编辑项目',exact:true}).count(),0);assert.equal(await page.locator('.project-card').count(),1);assert.match(await page.locator('.project-card').innerText(),/p2/);assert.deepEqual(errors,[]);
   await page.getByRole('button',{name:'退出登录'}).click();await page.locator('#login').waitFor();await page.getByRole('button',{name:'没有账号？注册'}).click();
   await page.getByLabel('账号',{exact:true}).fill('ui-owner');await page.getByLabel('姓名',{exact:true}).fill('自助注册');await page.getByLabel('密码',{exact:true}).fill('abcdef');await page.getByLabel('确认密码',{exact:true}).fill('abcdef');await page.getByRole('button',{name:'注册账号',exact:true}).click();await page.getByRole('button',{name:'登录工作台'}).waitFor();await page.getByLabel('密码',{exact:true}).fill('abcdef');await page.getByRole('button',{name:'登录工作台'}).click();
   await page.getByRole('button',{name:'项目与环境',exact:true}).click();await page.getByRole('button',{name:'＋ 新建项目'}).click();await page.getByLabel('项目名称').fill('注册用户项目');await page.getByLabel('环境地址').fill(base);await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'登录态',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'上传 JSON'}).count(),0);assert.equal(await page.getByRole('button',{name:'采集页面',exact:true}).count(),0);
   await page.getByRole('button',{name:'页面采集与依据'}).click();await page.getByRole('button',{name:'采集页面',exact:true}).waitFor();await page.locator('.modal-footer').getByRole('button',{name:'关闭',exact:true}).click();
   await page.getByRole('button',{name:'测试计划',exact:true}).click();await page.getByRole('button',{name:'手工编写',exact:true}).click();await page.getByLabel('计划名称').fill('人员管理');await page.getByLabel('测试用例与预期结果').fill('### TC-01 查询\n### TC-02 重置');await page.getByRole('button',{name:'保存为待审核'}).click();await page.getByRole('button',{name:'审核通过',exact:true}).click();await page.getByRole('button',{name:'确认审核通过'}).click();await page.getByRole('button',{name:'建立用例模块'}).click();await page.getByLabel('已核对全部用例清单').check();await page.getByRole('button',{name:'建立模块',exact:true}).click();await page.locator('.tree-module > summary').click();assert.equal(await page.getByRole('button',{name:'生成此用例'}).count(),2);await page.getByRole('button',{name:'生成此用例'}).first().click();assert.equal(await page.getByLabel('TC-01 查询',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('TC-02 重置',{exact:true}).isChecked(),false);assert.equal(await page.locator('[name=liveValidation]').count(),1);await page.locator('.modal-footer').getByRole('button',{name:'关闭',exact:true}).click();
   await page.screenshot({path:'/tmp/testhub131-modules.png',fullPage:true});await page.getByRole('button',{name:'查看 / 编辑',exact:true}).click();await page.getByRole('button',{name:'单用例管理',exact:true}).click();await page.locator('#modal').getByRole('button',{name:'生成此用例'}).first().waitFor();assert.equal(await page.locator('#modal').getByRole('button',{name:'生成此用例'}).count(),2);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }finally{child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(data,{recursive:true,force:true});}
});
