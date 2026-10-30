import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

test('personnel organization tree promotes empty levels, indents under CSP, filters users and preserves collapsed state',{timeout:45000},async()=>{
 const users=[
  {id:'u0',username:'rootuser',displayName:'直属人员',company:'',department:'',section:'',role:'viewer',enabled:true},
  {id:'u1',username:'fulluser',displayName:'完整人员',company:'公司甲',department:'信息部',section:'质控处',role:'tester',enabled:true},
  {id:'u2',username:'companyuser',displayName:'公司直属',company:'公司甲',department:'',section:'',role:'viewer',enabled:true},
  {id:'u3',username:'departmentuser',displayName:'部门直属',company:'公司甲',department:'信息部',section:'',role:'viewer',enabled:false},
  {id:'u4',username:'orphanuser',displayName:'孤立部门人员',company:'',department:'运营部',section:'',role:'viewer',enabled:true},
  {id:'u5',username:'sectionuser',displayName:'跨级人员',company:'公司甲',department:'',section:'直接处室',role:'viewer',enabled:true}
 ];
 const state={me:{id:'admin',role:'admin',enabled:true,ownedProjectIds:['p'],projectIds:[]},projects:[{id:'p',name:'项目',ownerId:'admin',baseURL:'http://fixture',entry:'/',auth:false}],plans:[],suites:[],evidence:[],jobs:[],workers:[],model:{configured:false},trash:{plans:[],suites:[]}};
 const server=http.createServer(async(req,res)=>{
  try{
   for await(const _ of req){}
   if(req.url.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(req.url==='/api/state'?state:req.url==='/api/users'?users:req.url.endsWith('/members')?{version:'1',users:users.map(u=>({...u,domainAccount:u.username,role:'viewer'}))}:{ok:true}));return;
   }
   const file={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/personnel-ui.css':'personnel-ui.css','/favicon.svg':'favicon.svg'}[req.url];
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');
   res.end(await readFile('public/'+file));
  }catch(e){res.statusCode=500;res.end(e.message);}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-zygote','--disable-gpu']}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'人员管理',exact:true}).click();
  await expect(page.locator('.personnel-table tbody tr')).toHaveCount(6);await page.waitForFunction(()=>!!document.getElementById('personnel-styles')?.sheet);await expect(page.locator('.org-tree')).not.toContainText('未分配');
  const org=page.locator('.personnel-org .org-tree');
  await expect(org.locator(':scope > .org-person')).toHaveCount(1);await expect(org.locator(':scope > .org-person')).toContainText('直属人员');
  const company=org.locator(':scope > details.org-node').filter({hasText:'公司甲'});
  await expect(company.locator(':scope > .org-children > .org-person')).toContainText('公司直属');
  const dept=company.locator(':scope > .org-children > details.org-node').filter({hasText:'信息部'});
  await expect(dept.locator(':scope > .org-children > .org-person')).toContainText('部门直属');
  const section=dept.locator(':scope > .org-children > details.org-node');
  const x1=(await company.locator(':scope > summary').boundingBox()).x,x2=(await dept.locator(':scope > summary').boundingBox()).x,x3=(await section.locator(':scope > summary').boundingBox()).x;
  assert.ok(x2>x1+10&&x3>x2+10,'nested organizations must have visible CSS indentation');
  await expect(company.locator(':scope > .org-children > details.org-node').filter({hasText:'直接处室'})).toHaveCount(1);
  await expect(org.locator(':scope > details.org-node').filter({hasText:'运营部'})).toHaveCount(1);
  await page.screenshot({path:'/tmp/personnel-ui-new.png',fullPage:true});
  await dept.locator(':scope > summary > button').click();await expect(page.locator('.personnel-table tbody tr')).toHaveCount(2);
  await org.locator('button[data-id="u0"]').click();await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1);await expect(page.locator('.personnel-table')).toContainText('直属人员');
  await page.getByRole('button',{name:/^全部人员/}).click();await page.getByLabel('账号 / 姓名 / 组织').fill('孤立');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1);await expect(page.locator('.personnel-table')).toContainText('孤立部门人员');
  await page.getByRole('button',{name:'重置',exact:true}).click();await page.getByLabel('状态',{exact:true}).selectOption('disabled');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.locator('.personnel-table')).toContainText('部门直属');await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:'重置',exact:true}).click();await company.locator(':scope > summary > .org-chevron').click();await expect(company).not.toHaveAttribute('open','');
  await page.waitForResponse(r=>r.url().endsWith('/api/state')&&r.ok());await expect(company).not.toHaveAttribute('open','');
  await page.setViewportSize({width:850,height:1000});assert.equal(await page.locator('.personnel-layout').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
  await page.getByRole('button',{name:'项目与环境',exact:true}).click();await page.getByRole('button',{name:'项目成员',exact:true}).click();await expect(page.locator('#modal .org-tree')).not.toContainText('未分配');await expect(page.locator('#modal .org-tree > .org-person')).toContainText('直属人员');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
