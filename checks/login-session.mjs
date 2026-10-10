import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from '@playwright/test';
import {LoginSessions} from '../src/login-sessions.mjs';
const launch=()=>chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:['--no-zygote','--disable-gpu']}:{})});
test('manual login saves reusable cookies/localStorage/IndexedDB; ownership, cancellation and expiry',{timeout:60000},async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<input id="account"><input id="password" type="password"><button id="login" onclick="document.cookie='session=fixture;path=/';localStorage.setItem('token','fixture');document.body.dataset.logged='yes'">Login</button><script>const r=indexedDB.open('auth',1);r.onupgradeneeded=()=>r.result.createObjectStore('tokens');r.onsuccess=()=>r.result.transaction('tokens','readwrite').objectStore('tokens').put('fixture','token');</script>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;let saved=null;const manager=new LoginSessions({launch,save:async(p,state)=>{saved=state;}});let replay;
 try{
  const s=await manager.start('owner',{id:'project',baseURL:url,entry:'/'});
  assert.throws(()=>manager.owned(s.id,'other'),e=>e.status===403);
  await assert.rejects(manager.start('owner',{id:'project',baseURL:url,entry:'/'}),e=>e.status===409);
  const page=manager.sessions.get(s.id).page;
  const box=await page.locator('#account').boundingBox();await manager.input(s.id,'owner',{type:'click',x:box.x+5,y:box.y+5});await manager.input(s.id,'owner',{type:'text',text:'tester'});assert.equal(await page.locator('#account').inputValue(),'tester');
  await manager.input(s.id,'owner',{type:'key',key:'Tab'});await manager.input(s.id,'owner',{type:'text',text:'test-password'});assert.equal(await page.locator('#password').inputValue(),'test-password');
  const button=await page.locator('#login').boundingBox();await manager.input(s.id,'owner',{type:'down',x:button.x+5,y:button.y+5});await manager.input(s.id,'owner',{type:'up',x:button.x+5,y:button.y+5});
  const frame=await manager.frame(s.id,'owner');assert.ok(frame.image.length>1000);
  await assert.rejects(manager.persist(s.id,'owner',false),e=>e.status===400);assert.equal(saved,null);
  await manager.persist(s.id,'owner',true);assert.equal(manager.sessions.size,0);assert.ok(saved.cookies.some(c=>c.name==='session'));assert.ok(saved.origins[0].indexedDB.length);
  replay=await launch();const context=await replay.newContext({storageState:saved});const fresh=await context.newPage();await fresh.goto(url);assert.equal(await fresh.evaluate(()=>localStorage.getItem('token')),'fixture');assert.ok((await context.cookies()).some(c=>c.name==='session'));
  const second=await manager.start('owner',{id:'project',baseURL:url,entry:'/'});const original=saved;await manager.close(second.id);assert.equal(saved,original);
  const expired=await manager.start('owner',{id:'project',baseURL:url,entry:'/'});manager.sessions.get(expired.id).expires=0;assert.throws(()=>manager.owned(expired.id,'owner'),e=>e.status===410);
 }finally{await manager.dispose();await replay?.close();await new Promise(r=>server.close(r));}
});

test('login window UI drives remote browser and saves state',{timeout:60000},async()=>{
 const {readFile}=await import('node:fs/promises');let saved;const manager=new LoginSessions({launch,save:async(p,s)=>{saved=s;}});let ui;
 const server=http.createServer(async(req,res)=>{try{
  const pathname=new URL(req.url,'http://localhost').pathname;let data='';for await(const c of req)data+=c;const body=data?JSON.parse(data):{};
  if(pathname==='/fixture'){res.setHeader('Content-Type','text/html');return res.end('<input id="account"><button onclick="document.cookie=\'login=yes;path=/\'">Login</button>');}
  if(pathname.startsWith('/api/')){let result;const id=pathname.split('/')[3];if(pathname.endsWith('/login-session'))result=await manager.start('owner',{id:'ui',baseURL:base,entry:'/fixture'});else if(pathname.endsWith('/frame'))result=await manager.frame(id,'owner');else if(pathname.endsWith('/input'))result=await manager.input(id,'owner',body);else if(pathname.endsWith('/save'))result=await manager.persist(id,'owner',body.confirmed);else{await manager.close(id);result={ok:true};}res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));}
  const files={'/login-browser':'login-browser.html','/login-browser.js':'login-browser.js','/style.css':'style.css'};res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');res.end(await readFile('public/'+files[pathname]));
 }catch(e){res.statusCode=e.status||500;res.end(JSON.stringify({error:e.message}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{ui=await launch();const page=await ui.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/login-browser?project=ui');await page.getByRole('button',{name:'打开登录页面'}).click();await page.locator('#screen').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#screen').naturalWidth===1280);
  const remote=[...manager.sessions.values()][0].page;const box=await remote.locator('#account').boundingBox();const screen=await page.locator('#screen').boundingBox();await page.mouse.click(screen.x+(box.x+5)*screen.width/1280,screen.y+(box.y+5)*screen.width/1280);await page.keyboard.type('tester');await new Promise(r=>setTimeout(r,300));assert.equal(await remote.locator('#account').inputValue(),'tester');
  await page.screenshot({path:'/tmp/testhub-login-ui.png',fullPage:true});await page.locator('#confirmed').check();await page.getByRole('button',{name:'保存登录态到项目'}).click();await page.getByText('登录态已保存到项目，可以返回工作台执行测试。').waitFor();assert.ok(saved);assert.equal(manager.sessions.size,0);assert.deepEqual(errors,[]);
 }finally{await ui?.close();await manager.dispose();await new Promise(r=>server.close(r));}
});
