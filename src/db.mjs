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
export async function enqueue(kind,payload){const id=randomUUID(),t=now();await query("INSERT INTO jobs(id,kind,status,payload,log,created,updated) VALUES(?,?,'queued',?,'',?,?)",[id,kind,JSON.stringify(payload),t,t]);return job(id);}
export async function job(id){return decode((await query('SELECT * FROM jobs WHERE id=?',[id]))[0]);}
export async function jobs(){return (await query('SELECT * FROM jobs ORDER BY created DESC LIMIT 200')).map(decode);}
export async function log(id,s){await query('UPDATE jobs SET log=RIGHT(CONCAT(log,?),120000),updated=? WHERE id=?',[s,now(),id]);}
export async function finish(id,status,result){await query("UPDATE jobs SET status=CASE WHEN cancel=1 THEN 'cancelled' ELSE ? END,result=?,updated=? WHERE id=? AND status='running'",[status,JSON.stringify(result),now(),id]);}
export async function claim(){const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT * FROM jobs WHERE status='queued' AND cancel=0 ORDER BY created,id LIMIT 1 FOR UPDATE SKIP LOCKED");const r=rows[0];if(r){r.status='running';r.updated=now();await c.execute("UPDATE jobs SET status='running',updated=? WHERE id=?",[r.updated,r.id]);}await c.commit();return decode(r);}catch(e){await c.rollback();throw e;}finally{c.release();}}
// A dedicated connection owns a database-scoped advisory lock for the whole worker lifetime.
export async function acquireWorker(){const c=await pool.getConnection();try{const name='testhub:'+process.env.DB_NAME+':worker';const [rows]=await c.execute('SELECT GET_LOCK(?,0) AS acquired',[name]);if(rows[0].acquired!==1)throw new Error('Only one worker is supported; another worker holds the lock.');return c;}catch(e){c.release();throw e;}}
