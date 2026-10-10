import mysql from 'mysql2/promise';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const DATA=path.resolve(process.env.DATA_DIR||'data');
mkdirSync(DATA,{recursive:true,mode:0o700});
export const pool=mysql.createPool({host:process.env.DB_HOST||'mysql',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'testhub',password:process.env.DB_PASSWORD,database:process.env.DB_NAME||'testhub',charset:'utf8mb4',waitForConnections:true,connectionLimit:5,connectTimeout:10000});
export const now=()=>new Date().toISOString();
export async function query(sql,args=[]){const [rows]=await pool.execute(sql,args);return rows;}
export async function init(){
 await query(`CREATE TABLE IF NOT EXISTS records(id VARCHAR(36) PRIMARY KEY,kind VARCHAR(32) NOT NULL,body LONGTEXT NOT NULL,created CHAR(24) NOT NULL,updated CHAR(24) NOT NULL,INDEX records_kind(kind,created)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
 await query(`CREATE TABLE IF NOT EXISTS jobs(id VARCHAR(36) PRIMARY KEY,kind VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL,payload LONGTEXT NOT NULL,result LONGTEXT,log LONGTEXT NOT NULL,created CHAR(24) NOT NULL,updated CHAR(24) NOT NULL,cancel TINYINT NOT NULL DEFAULT 0,INDEX jobs_queue(status,cancel,created,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
 await query(`CREATE TABLE IF NOT EXISTS workers(id VARCHAR(64) PRIMARY KEY,heartbeat CHAR(24) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}
const record=r=>r?({...JSON.parse(r.body),id:r.id,created:r.created,updated:r.updated}):null;
const decode=r=>r?({...r,payload:JSON.parse(r.payload),result:r.result?JSON.parse(r.result):null}):null;
export async function list(kind){return (await query('SELECT * FROM records WHERE kind=? ORDER BY created DESC',[kind])).map(record);}
export async function get(id,kind){const [r]=await query('SELECT * FROM records WHERE id=?',[id]);return !r||(kind&&r.kind!==kind)?null:record(r);}
export async function put(kind,body,id=randomUUID()){const t=now(),s=JSON.stringify(body);await query('INSERT INTO records(id,kind,body,created,updated) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE body=?,updated=?',[id,kind,s,t,t,s,t]);return get(id);}
export async function enqueue(kind,payload){
 const c=await pool.getConnection();try{await c.beginTransaction();
 const refs=[payload.suiteId,payload.suite?.id,...(kind==='generator'?[payload.plan?.id]:[])].filter(Boolean);
 for(const id of [...new Set(refs)].sort()){const [rows]=await c.execute('SELECT body FROM records WHERE id=? FOR UPDATE',[id]);if(!rows.length||JSON.parse(rows[0].body).deletedAt)throw Object.assign(new Error('计划或脚本已删除，请刷新'),{status:409});}
 const id=randomUUID(),t=now();await c.execute("INSERT INTO jobs(id,kind,status,payload,log,created,updated) VALUES(?,?,'queued',?,'',?,?)",[id,kind,JSON.stringify(payload),t,t]);await c.commit();return job(id);
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function recycleRecord(id,kind,restore=false){
 const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute('SELECT * FROM records WHERE id=? AND kind=? FOR UPDATE',[id,kind]);if(!rows.length)throw Object.assign(new Error('记录不存在'),{status:404});
 const old=record(rows[0]);
 const [active]=await c.execute("SELECT id FROM jobs WHERE status IN ('queued','running') AND (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.suiteId'))=? OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.suite.id'))=? OR JSON_UNQUOTE(JSON_EXTRACT(payload,'$.plan.id'))=?) LIMIT 1",[id,id,id]);
 if(active.length)throw Object.assign(new Error('存在排队或运行中的关联任务，请等待结束或取消后再管理'),{status:409});
 const next={...old,deletedAt:restore?null:now(),approved:false,...(kind==='suite'?{validation:null,caseValidations:{}}:{})};const t=new Date(Math.max(Date.now(),Date.parse(old.updated)+1)).toISOString();await c.execute('UPDATE records SET body=?,updated=? WHERE id=?',[JSON.stringify(next),t,id]);await c.commit();return {...next,updated:t};
 }catch(e){await c.rollback();throw e;}finally{c.release();}
}
export async function suitePlan(suite){
 if(suite.planSnapshot)return suite.planSnapshot;
 const rows=await query("SELECT payload FROM jobs WHERE kind='generator' AND JSON_UNQUOTE(JSON_EXTRACT(result,'$.suiteId'))=? ORDER BY created DESC LIMIT 1",[suite.id]);
 const plan=rows.length?JSON.parse(rows[0].payload).plan:null;
 if(!plan)throw Object.assign(new Error('缺少生成时的计划快照，请从测试计划重新生成'),{status:409});
 return plan;
}
export async function job(id){return decode((await query('SELECT * FROM jobs WHERE id=?',[id]))[0]);}
export async function jobs(){return (await query('SELECT * FROM jobs ORDER BY created DESC LIMIT 200')).map(decode);}
export async function log(id,s){await query('UPDATE jobs SET log=RIGHT(CONCAT(log,?),120000),updated=? WHERE id=?',[s,now(),id]);}
export async function finish(id,status,result){await query("UPDATE jobs SET status=CASE WHEN cancel=1 THEN 'cancelled' ELSE ? END,result=?,updated=? WHERE id=? AND status='running'",[status,JSON.stringify(result),now(),id]);}
export async function claim(){const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT * FROM jobs WHERE status='queued' AND cancel=0 ORDER BY created,id LIMIT 1 FOR UPDATE SKIP LOCKED");const r=rows[0];if(r){r.status='running';r.updated=now();await c.execute("UPDATE jobs SET status='running',updated=? WHERE id=?",[r.updated,r.id]);}await c.commit();return decode(r);}catch(e){await c.rollback();throw e;}finally{c.release();}}
// A dedicated connection owns a database-scoped advisory lock for the whole worker lifetime.
export async function acquireWorker(){const c=await pool.getConnection();try{const name='testhub:'+process.env.DB_NAME+':worker';const [rows]=await c.execute('SELECT GET_LOCK(?,0) AS acquired',[name]);if(rows[0].acquired!==1)throw new Error('Only one worker is supported; another worker holds the lock.');return c;}catch(e){c.release();throw e;}}
// Optimistic write: a concurrent edit/review prevents replacement of a stale snapshot.
export async function replaceRecord(id,expectedUpdated,body){const t=new Date(Math.max(Date.now(),Date.parse(expectedUpdated)+1)).toISOString();const result=await query('UPDATE records SET body=?,updated=? WHERE id=? AND updated=?',[JSON.stringify(body),t,id,expectedUpdated]);if(result.affectedRows!==1)throw Object.assign(new Error('记录已变化，请刷新后重试'),{status:409});return get(id);}
