import {randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(derive);
export const deny=(message='无权访问此数据',status=403)=>{throw Object.assign(new Error(message),{status});};
export function canProject(user,id){return !!user?.enabled&&(user.role==='admin'||!!id&&(user.projectIds.includes(id)||ownsProject(user,id)));}
export function ownsProject(user,id){return !!user?.enabled&&!!id&&(user.ownedProjectIds||[]).includes(id);}
export function requireExecution(user,id){if(user?.role!=='admin'&&!ownsProject(user,id))deny('此操作需要管理员或项目所有者权限');}
export function requireProject(user,id){if(!canProject(user,id))deny('记录不存在或无权访问',404);}
export function requireAdmin(user){if(user?.role!=='admin'||!user.enabled)deny('此操作需要管理员权限');}
export function permitRoute(user,method,path,projectId){
 if(!user?.enabled)deny('账号已停用',401);
 if(user.role==='admin')return;
 if(path==='/api/logout'||path==='/api/me/password')return;
 if(path.startsWith('/api/users'))deny('人员管理仅限管理员');
 if(method==='GET'||method==='HEAD')return;
 if(/^\/api\/jobs\/[\w-]+\/report-link$/.test(path)&&method==='POST')return;
 if(path==='/api/projects'&&method==='POST')return;
 if(ownsProject(user,projectId))return;
 if(user.role==='viewer')deny('只读账号不能修改或执行任务');
 // Unreviewed JavaScript has worker process privileges. Admins and project owners execute or approve it in this trusted internal workspace.
 if(path==='/api/validate'||/^\/api\/suites\/[\w-]+\/approve$/.test(path))deny('未审核脚本的试运行和审核需要管理员权限');
 if(path.startsWith('/api/projects')||path.startsWith('/api/login-sessions'))deny('项目环境和共享登录态由管理员管理');
}
export function accountInput(b){
 const username=String(b.username||'').trim().toLowerCase(),displayName=String(b.displayName||'').trim();
 if(!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))deny('账号需为 3–64 位字母、数字、点、下划线或连字符',400);
 if(!displayName||displayName.length>100)deny('姓名必填，最多 100 字',400);
 if(!['admin','tester','viewer'].includes(b.role))deny('角色不正确',400);
 if(!Array.isArray(b.projectIds)||b.projectIds.some(x=>typeof x!=='string')||b.projectIds.length>1000)deny('项目权限格式不正确',400);
 return{username,displayName,role:b.role,enabled:b.enabled!==false,projectIds:[...new Set(b.projectIds)]};
}
export async function hashPassword(password){
 if(typeof password!=='string'||password.length<6||password.length>256)deny('密码需为 6–256 个字符',400);
 const salt=randomBytes(16).toString('hex'),key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password,hash){
 if(typeof password!=='string'||password.length>256)return false;
 const [scheme,salt,hex]=String(hash||'').split('$');if(scheme!=='scrypt'||!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{128}$/.test(hex||''))return false;
 const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}),expected=Buffer.from(hex,'hex');
 return key.length===expected.length&&timingSafeEqual(key,expected);
}
export function publicAccount(row){if(!row)return null;const {passwordHash,sessionVersion,...safe}=row;return safe;}
