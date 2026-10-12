import {randomBytes} from 'node:crypto';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
const fail=(message,status=404)=>{throw Object.assign(new Error(message),{status});};
const imageTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const videoTypes={'.webm':'video/webm','.mp4':'video/mp4'};
const textTypes=new Set(['.json','.txt','.log','.ts','.js','.mjs','.cjs','.md','.html','.css','.svg']);
// Playwright's report stores display preferences. Use frame-local memory instead
// of granting the report the application's origin/cookies/localStorage.
const reportStorageShim=`<script>(()=>{for(const name of ['localStorage','sessionStorage']){const data=Object.create(null);const api={getItem:k=>Object.hasOwn(data,k)?data[k]:null,setItem:(k,v)=>{data[k]=String(v)},removeItem:k=>{delete data[k]},clear:()=>{for(const k of Object.keys(data))delete data[k]},key:i=>Object.keys(data)[i]??null,get length(){return Object.keys(data).length}};Object.defineProperty(window,name,{value:new Proxy(api,{get:(t,k)=>k in t?t[k]:data[k],set:(t,k,v)=>{data[k]=String(v);return true}})});}})();</script>`;
export function artifactKind(name){const ext=path.extname(name).toLowerCase();return imageTypes[ext]?'image':videoTypes[ext]?'video':textTypes.has(ext)?'text':'download';}
export async function artifactPath(root,name){
 if(!name||name.includes('\\')||name.includes('\0')||path.isAbsolute(name))fail('文件路径不允许',403);
 const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||/^storage\.json$/i.test(p)))fail('文件路径不允许',403);
 try{
  if((await lstat(root)).isSymbolicLink())fail('文件路径不允许',403);
  let file=root;for(const part of parts){file=path.join(file,part);const s=await lstat(file);if(s.isSymbolicLink())fail('禁止读取链接文件',403);}
  const stat=await lstat(file);if(!stat.isFile())fail('文件不存在');return{file,stat};
 }catch(e){if(e.status)throw e;fail('文件不存在');}
}
export async function listArtifacts(root){
 const files=[];
 async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink()||e.name.startsWith('.')||/^storage\.json$/i.test(e.name))continue;const name=prefix+e.name;if(e.isDirectory())await walk(path.join(dir,e.name),name+'/');else{const {stat}=await artifactPath(root,name);files.push({name,size:stat.size,kind:artifactKind(name)});}}}
 try{await walk(root);}catch(e){if(e.code!=='ENOENT')throw e;}return files;
}
export async function sendArtifact(req,res,root,name,{inline=false,report=false}={}){
 const {file,stat}=await artifactPath(root,name),ext=path.extname(name).toLowerCase(),kind=artifactKind(name);
 if(report&&name==='html-report/index.html'){
  const original=await readFile(file,'utf8'),html=/<head\b[^>]*>/i.test(original)?original.replace(/<head\b[^>]*>/i,head=>head+reportStorageShim):reportStorageShim+original;
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(html)});return res.end(req.method==='HEAD'?undefined:html);
 }
 if(inline&&!report&&kind==='text'){
  if(stat.size>2_000_000)fail('文本超过 2MB，请下载查看',413);
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(JSON.stringify({name,text:await readFile(file,'utf8')}));
 }
 let type='application/octet-stream';
 if(inline)type=imageTypes[ext]||videoTypes[ext]||type;
 if(report)type=({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.woff2':'font/woff2','.ttf':'font/ttf','.svg':'image/svg+xml'}[ext])||imageTypes[ext]||videoTypes[ext]||type;
 const headers={'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':stat.size};
 if(!inline&&!report)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`;
 let start=0,end=stat.size-1,status=200;
 if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
  start=m[1]?Number(m[1]):Math.max(0,stat.size-Number(m[2]));end=m[1]&&m[2]?Math.min(Number(m[2]),stat.size-1):stat.size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return res.end();}
  status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;headers['Content-Length']=end-start+1;
 }
 res.writeHead(status,headers);if(req.method==='HEAD'||!stat.size)return res.end();
 try{await pipeline(createReadStream(file,{start,end}),res);}catch(e){if(!res.destroyed)throw e;}
}
export function createReportService({data,ownerActive,ttl=30*60*1000}){
 const grants=new Map();
 return{
  async issue(jobId,owner){
   const root=path.join(data,'runs',jobId);await artifactPath(root,'html-report/index.html');
   for(const [key,g]of grants)if(g.expiresAt<=Date.now()||!ownerActive(g.owner))grants.delete(key);
   const token=randomBytes(32).toString('hex'),expiresAt=Date.now()+ttl;grants.set(token,{jobId,owner,expiresAt});
   return{url:`/report-assets/${token}/index.html`,expiresAt};
  },
  async handle(req,res,u){
   const m=u.pathname.match(/^\/report-assets\/([a-f0-9]{64})\/(.+)$/);if(!m)return false;
   const grant=grants.get(m[1]);if(!grant||grant.expiresAt<=Date.now()||!ownerActive(grant.owner)){grants.delete(m[1]);fail('报告访问已过期，请从平台重新打开',401);}
   if(!['GET','HEAD'].includes(req.method))fail('仅允许读取报告',405);
   const origin=new URL('http://'+req.headers.host).host; // Source restriction uses the request authority; no redirect or proxy fetch.
   res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Referrer-Policy','no-referrer');
   res.setHeader('Content-Security-Policy',`sandbox allow-scripts allow-downloads allow-popups; default-src 'none'; script-src 'unsafe-inline' http://${origin} https://${origin} blob:; style-src 'unsafe-inline' http://${origin} https://${origin}; connect-src http://${origin} https://${origin} data: blob:; img-src http://${origin} https://${origin} data: blob:; media-src http://${origin} https://${origin} blob:; font-src http://${origin} https://${origin} data:; worker-src blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`);
   let name;try{name=decodeURIComponent(m[2]);}catch{fail('文件路径不允许',403);}
   // The trace UI needs service workers and an origin. Keep it isolated and offer its ZIP here.
   if(name==='trace/index.html'){
    const links=[];for(const raw of u.searchParams.getAll('trace')){try{const trace=new URL(raw,'http://'+req.headers.host);const prefix='/report-assets/'+m[1]+'/';if(trace.host!==req.headers.host||!trace.pathname.startsWith(prefix))continue;const relative=decodeURIComponent(trace.pathname.slice(prefix.length));if(!relative.startsWith('data/')||!relative.endsWith('.zip'))continue;await artifactPath(path.join(data,'runs',grant.jobId),'html-report/'+relative);links.push(`<a href="${prefix+relative.split('/').map(encodeURIComponent).join('/')}" download>下载 Trace ZIP</a>`);}catch{}}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<!doctype html><meta charset="utf-8"><p>截图、视频和错误详情可直接在报告查看。Trace 时间线暂保留下载查看。</p>'+links.join('<br>'));return true;
   }
   if(name!=='index.html'&&name!=='report.js'&&name!=='report.css'&&!name.startsWith('data/'))fail('报告资源不存在');
   await sendArtifact(req,res,path.join(data,'runs',grant.jobId),'html-report/'+name,{report:true});return true;
  }
 };
}
