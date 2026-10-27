import { init, pool } from '../src/db.mjs';
try { await init(); console.log('MySQL tables ready.'); } finally { await pool.end(); }
