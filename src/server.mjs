import http from 'node:http';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {DATA,db,list,get,put,jobs,job,enqueue,now} from './db.mjs';
import {seed} from './seed.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const secret=process.env.ADMIN_PASSWORD;
if(!secret||secret.length<12)throw new Error('ADMIN_PASSWORD must contain at least 12 characters. Use scripts/setup.mjs.');
const sessions=new Map(),attempts=new Map();
const hash=x=>createHash('sha256').update(x).digest();
const same=(a,b)=>timingSafeEqual(hash(a),hash(b));
seed();
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function err(message,status=400){throw Object.assign(new Error(message),{status});}
function required(value,label,max=20000){if(typeof value!=='string'||!value.trim()||value.length>max)err(`${label}不能为空，且长度不能超过 ${max}`);return value.trim();}
function projectInput(b){const baseURL=required(b.baseURL,'环境地址',2000);let u;try{u=new URL(baseURL);}catch{err('环境地址格式不正确');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)err('仅支持不含凭证的 HTTP/HTTPS 地址');if(!String(b.entry||'/').startsWith('/')||String(b.entry).startsWith('//'))err('入口路径必须以单个 / 开头');return {name:required(b.name,'项目名称',100),baseURL:u.origin,entry:String(b.entry||'/'),description:String(b.description||'').slice(0,5000)};}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(Buffer.byteLength(s)>2_000_000)err('请求内容超过 2MB',413);}try{return JSON.parse(s||'{}');}catch{err('JSON 格式错误');}}
function must(id,kind){const v=get(id,kind);if(!v)err('记录不存在',404);return v;}
const server=http.createServer(async(req,res)=>{
res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
try{
const u=new URL(req.url,'http://localhost'),p=u.pathname,m=req.method;
if(p==='/health')return send(res,200,{ok:true});
if(p==='/api/login'&&m==='POST'){
 const ip=req.socket.remoteAddress,t=Date.now(),a=attempts.get(ip)||{start:t,count:0};if(t-a.start>900000){a.start=t;a.count=0;}a.count++;attempts.set(ip,a);if(a.count>20)err('登录尝试过多，请15分钟后重试',429);
 const b=await body(req);if(!same(String(b.password||''),secret))err('密码不正确',401);
 const token=randomBytes(32).toString('hex');sessions.set(token,t+8*3600000);for(const [k,v]of sessions)if(v<t)sessions.delete(k);
 res.setHeader('Set-Cookie',`testhub=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);return send(res,200,{ok:true});
}
if(p.startsWith('/api/')){
 const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('testhub='))?.slice(8);
 if(!cookie||(sessions.get(cookie)||0)<Date.now())err('请先登录',401);
 if(!['GET','HEAD'].includes(m)&&req.headers.origin){if(new URL(req.headers.origin).host!==req.headers.host)err('跨站请求被拒绝',403);}
 if(p==='/api/logout'&&m==='POST'){sessions.delete(cookie);res.setHeader('Set-Cookie','testhub=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});}
 if(p==='/api/state'&&m==='GET')return send(res,200,{projects:list('project'),plans:list('plan'),suites:list('suite'),jobs:jobs().map(({payload,log,...j})=>({...j,projectId:payload.projectId,name:payload.name})),workers:db.prepare('SELECT * FROM workers').all(),model:{configured:!!process.env.LLM_BASE_URL&&!!process.env.LLM_MODEL,model:process.env.LLM_MODEL||'',baseURL:process.env.LLM_BASE_URL||''}});
 if(p==='/api/projects'&&m==='POST')return send(res,201,put('project',{...projectInput(await body(req)),auth:false}));
 let match;
 if((match=p.match(/^\/api\/projects\/([\w-]+)$/))&&m==='PUT'){const old=must(match[1],'project');return send(res,200,put('project',{...old,...projectInput(await body(req))},old.id));}
 if((match=p.match(/^\/api\/projects\/([\w-]+)\/auth$/))&&m==='POST'){
 const pr=must(match[1],'project'),b=await body(req);if(!Array.isArray(b.cookies)||!Array.isArray(b.origins))err('请上传完整的 Playwright storageState JSON');
 await mkdir(path.join(DATA,'auth'),{recursive:true,mode:0o700});await writeFile(path.join(DATA,'auth',pr.id+'.json'),JSON.stringify(b),{mode:0o600});put('project',{...pr,auth:true},pr.id);return send(res,200,{ok:true});}
 if(p==='/api/plans'&&m==='POST'){const b=await body(req);must(b.projectId,'project');return send(res,201,put('plan',{projectId:b.projectId,name:required(b.name,'计划名称',100),requirement:String(b.requirement||''),content:required(b.content,'用例内容',100000),approved:false}));}
 if((match=p.match(/^\/api\/plans\/([\w-]+)$/))&&m==='PUT'){const old=must(match[1],'plan'),b=await body(req);return send(res,200,put('plan',{...old,name:required(b.name,'计划名称',100),content:required(b.content,'用例内容',100000),approved:false},old.id));}
 if(p==='/api/suites'&&m==='POST'){const b=await body(req);must(b.projectId,'project');return send(res,201,put('suite',{projectId:b.projectId,name:required(b.name,'脚本名称',100),code:required(b.code,'脚本',200000),approved:false}));}
 if((match=p.match(/^\/api\/suites\/([\w-]+)$/))&&m==='PUT'){const old=must(match[1],'suite'),b=await body(req);return send(res,200,put('suite',{...old,name:required(b.name,'脚本名称',100),code:required(b.code,'脚本',200000),approved:false},old.id));}
 if((match=p.match(/^\/api\/(plans|suites)\/([\w-]+)\/approve$/))&&m==='POST'){const kind=match[1]==='plans'?'plan':'suite',old=must(match[2],kind);return send(res,200,put(kind,{...old,approved:true,approvedAt:now()},old.id));}
 if(p==='/api/planner'&&m==='POST'){const b=await body(req),pr=must(b.projectId,'project');return send(res,202,enqueue('planner',{projectId:pr.id,name:required(b.name,'计划名称',100),requirement:required(b.requirement,'需求',80000),project:pr}));}
 if(p==='/api/generator'&&m==='POST'){const b=await body(req),plan=must(b.planId,'plan');if(!plan.approved)err('请先审核测试计划');return send(res,202,enqueue('generator',{projectId:plan.projectId,name:plan.name,plan,project:must(plan.projectId,'project'),context:required(b.context,'页面定位依据',80000)}));}
 if(p==='/api/runs'&&m==='POST'){const b=await body(req),suite=must(b.suiteId,'suite');if(!suite.approved)err('请先审核脚本，修改后需重新审核');const pr=must(suite.projectId,'project');let storageState=null;if(pr.auth)storageState=JSON.parse(await readFile(path.join(DATA,'auth',pr.id+'.json'),'utf8'));
 const j=enqueue('run',{projectId:pr.id,name:suite.name,project:pr,suite,storageState});return send(res,202,{id:j.id,status:j.status});}
 if((match=p.match(/^\/api\/jobs\/([\w-]+)$/))&&m==='GET'){const j=job(match[1]);if(!j)err('任务不存在',404);const{payload,...safe}=j;return send(res,200,{...safe,name:payload.name,projectId:payload.projectId});}
 if((match=p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))&&m==='POST'){db.prepare("UPDATE jobs SET cancel=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated=? WHERE id=? AND status IN ('queued','running')").run(now(),match[1]);return send(res,200,{ok:true});}
 if((match=p.match(/^\/api\/jobs\/([\w-]+)\/analyze$/))&&m==='POST'){const j=job(match[1]);if(!j||j.kind!=='run'||!['passed','failed','error','interrupted'].includes(j.status))err('该执行结果暂不可分析');return send(res,202,enqueue('reporter',{projectId:j.payload.projectId,name:j.payload.name,runId:j.id,summary:j.result,log:j.log}));}
 if((match=p.match(/^\/api\/jobs\/([\w-]+)\/artifacts$/))&&m==='GET'){if(!job(match[1]))err('任务不存在',404);const dir=path.join(DATA,'runs',match[1]);let files=[];async function walk(d,prefix=''){for(const e of await readdir(d,{withFileTypes:true})){if(e.isSymbolicLink())continue;const n=prefix+e.name;if(e.isDirectory())await walk(path.join(d,e.name),n+'/');else if(!n.endsWith('storage.json'))files.push({name:n,size:(await stat(path.join(d,e.name))).size});}}try{await walk(dir);}catch(e){if(e.code!=='ENOENT')throw e;}return send(res,200,files);}
 if((match=p.match(/^\/api\/jobs\/([\w-]+)\/download$/))&&m==='GET'){if(!job(match[1]))err('任务不存在',404);const n=u.searchParams.get('file')||'';if(!n||n.includes('..')||n.includes('\\')||n.startsWith('/')||n.endsWith('storage.json'))err('文件路径不允许',403);const f=path.join(DATA,'runs',match[1],n);try{const data=await readFile(f);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(n))}`,'Cache-Control':'no-store'});return res.end(data);}catch{err('文件不存在',404);}}
 err('接口不存在',404);
}
if(m!=='GET')err('请求方法不支持',405);
const allowed={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/demo':'demo.html','/favicon.svg':'favicon.svg'};
if(!allowed[p])err('页面不存在',404);
const file=allowed[p];res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8'});res.end(await readFile(path.join(ROOT,'public',file)));
}catch(e){send(res,e.status||500,{error:e.status?e.message:'服务器处理失败，请查看服务器日志'});if(!e.status)console.error(e.message);}
});
server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log('TestHub listening on '+(process.env.PORT||8080)));
