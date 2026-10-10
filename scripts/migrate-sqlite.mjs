// Stop API and Worker before running. Requires an empty MySQL database.
import {DatabaseSync} from 'node:sqlite';
import {init,pool,now} from '../src/db.mjs';
const source=process.argv[2];
if(!source)throw new Error('Usage: npm run db:migrate -- /app/data/testhub.db');
const sqlite=new DatabaseSync(source,{readOnly:true});
let c;
try{
 await init();c=await pool.getConnection();await c.beginTransaction();
 for(const table of ['records','jobs','workers']){const [r]=await c.query(`SELECT COUNT(*) AS n FROM ${table}`);if(r[0].n)throw new Error('Target database must be empty. Stop services and use a new DB_NAME.');}
 for(const r of sqlite.prepare('SELECT * FROM records').all())await c.execute('INSERT INTO records(id,kind,body,created,updated) VALUES(?,?,?,?,?)',[r.id,r.kind,r.body,r.created,r.updated]);
 for(const r of sqlite.prepare('SELECT * FROM jobs').all()){
  if(['running','queued'].includes(r.status)){r.status='interrupted';r.updated=now();r.result=JSON.stringify({error:'Migration interrupted pending work; review before resubmitting.'});}
  const payload=JSON.parse(r.payload);delete payload.storageState;
  await c.execute('INSERT INTO jobs(id,kind,status,payload,result,log,created,updated,cancel) VALUES(?,?,?,?,?,?,?,?,?)',[r.id,r.kind,r.status,JSON.stringify(payload),r.result,r.log,r.created,r.updated,r.cancel]);
 }
 await c.commit();console.log('Migration committed. Keep the original auth/ and runs/ directories.');
}catch(e){if(c)await c.rollback();throw e;}finally{sqlite.close();c?.release();await pool.end();}
