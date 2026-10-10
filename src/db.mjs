import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const DATA=path.resolve(process.env.DATA_DIR||'data');
mkdirSync(DATA,{recursive:true,mode:0o700});
export const db=new DatabaseSync(path.join(DATA,'testhub.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,log TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,heartbeat TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created);`);
export const now=()=>new Date().toISOString();
export function list(kind){return db.prepare('SELECT * FROM records WHERE kind=? ORDER BY created DESC').all(kind).map(row=>({...JSON.parse(row.body),id:row.id,created:row.created,updated:row.updated}));}
export function get(id,kind){const r=db.prepare('SELECT * FROM records WHERE id=?').get(id);if(!r||(kind&&r.kind!==kind))return null;return {...JSON.parse(r.body),id:r.id,created:r.created,updated:r.updated};}
export function put(kind,body,id=randomUUID()){const t=now();db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(id,kind,JSON.stringify(body),t,t);return get(id);}
export function enqueue(kind,payload){const id=randomUUID(),t=now();db.prepare("INSERT INTO jobs(id,kind,status,payload,created,updated) VALUES(?,?,'queued',?,?,?)").run(id,kind,JSON.stringify(payload),t,t);return job(id);}
export function job(id){const j=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!j)return null;return {...j,payload:JSON.parse(j.payload),result:j.result?JSON.parse(j.result):null};}
export function jobs(){return db.prepare('SELECT id FROM jobs ORDER BY created DESC LIMIT 200').all().map(x=>job(x.id));}
export function log(id,s){db.prepare('UPDATE jobs SET log=substr(log || ?, -120000),updated=? WHERE id=?').run(s,now(),id);}
export function finish(id,status,result){db.prepare("UPDATE jobs SET status=CASE WHEN cancel=1 THEN 'cancelled' ELSE ? END,result=?,updated=? WHERE id=? AND status='running'").run(status,JSON.stringify(result),now(),id);}
export function claim(){db.exec('BEGIN IMMEDIATE');try{const r=db.prepare("SELECT id FROM jobs WHERE status='queued' AND cancel=0 ORDER BY created LIMIT 1").get();if(r)db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(now(),r.id);db.exec('COMMIT');return r?job(r.id):null;}catch(e){db.exec('ROLLBACK');throw e;}}
