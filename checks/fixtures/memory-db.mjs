// In-memory repository for exercising the real HTTP/account/session code without MySQL.
// It models the statements used by accounts; this is not a MySQL migration test.
import { randomUUID } from 'node:crypto';
export const DATA = process.env.DATA_DIR;
export const now = () => new Date().toISOString();
const users = [], records = new Map(), tasks = new Map();
for (const id of ['p1', 'p2']) {
    records.set(id, { id, kind: 'project', name: id, baseURL: 'http://fixture', entry: '/', auth: false });
    records.set('e' + id, { id: 'e' + id, kind: 'evidence', projectId: id, baseURL: 'http://fixture', entry: '/', capturedAt: '2000-01-01', confirmed: false, controls: [], tables: [] });
    records.set('s' + id, { id: 's' + id, kind: 'suite', projectId: id, name: id, code: "test('TC-01 查询',()=>{});", approved: true });
    tasks.set('j' + id, { id: 'j' + id, kind: 'run', status: 'failed', created: now(), payload: { projectId: id, name: id }, result: { total: 1 }, log: 'case log' });
}
export async function init() { }
export async function query(sql, args = []) {
    if (sql.startsWith('CREATE TABLE') || sql === 'SELECT 1') return [];
    if (sql === 'SELECT * FROM workers') return [];
    if (sql === 'SELECT id FROM users LIMIT 1') return users.slice(0, 1);
    if (sql.startsWith('SELECT * FROM users')) {
        if (sql.includes('WHERE id=')) return users.filter(u => u.id === args[0]);
        if (sql.includes('WHERE username=')) return users.filter(u => u.username === args[0]);
        return structuredClone(users);
    }
    if (sql.startsWith('INSERT IGNORE INTO users')) {
        if (!users.some(u => u.username === 'admin')) users.push({ id: args[0], username: 'admin', display_name: '管理员', role: 'admin', enabled: 1, project_ids: '[]', password_hash: args[1], session_version: 1, created: args[2], updated: args[3] }); return { affectedRows: 1 };
    }
    if (sql.startsWith('INSERT INTO users')) {
        if (users.some(u => u.username === args[1])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        users.push(Object.fromEntries(['id', 'username', 'display_name', 'role', 'enabled', 'project_ids', 'password_hash', 'created', 'updated'].map((k, i) => [k, args[i]]).concat([['session_version', 1]]))); return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE users SET display_name=')) {
        const u = users.find(u => u.id === args[6]); Object.assign(u, Object.fromEntries(['display_name', 'role', 'enabled', 'project_ids', 'password_hash', 'updated'].map((k, i) => [k, args[i]]))); u.session_version++; return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE users SET password_hash=')) {
        const u = users.find(u => u.id === args[2] && u.session_version === args[3]); if (!u) return { affectedRows: 0 }; u.password_hash = args[0]; u.updated = args[1]; u.session_version++; return { affectedRows: 1 };
    }
    if (sql.startsWith('UPDATE jobs')) return { affectedRows: 1 };
    throw new Error('Unmodeled SQL: ' + sql);
}
export const pool = { getConnection: async () => ({ beginTransaction: async () => { }, commit: async () => { }, rollback: async () => { }, release() { }, execute: async (...a) => [await query(...a)] }) };
export async function list(kind) { return [...records.values()].filter(x => x.kind === kind); }
export async function get(id, kind) { const r = records.get(id); return r && r.kind === kind ? structuredClone(r) : null; }
export async function put(kind, value, id = randomUUID()) { const r = { ...value, id, kind, updated: now() }; records.set(id, r); return structuredClone(r); }
export async function replaceRecord(id, version, value) { return put(records.get(id).kind, value, id); }
export async function recycleRecord(id, kind, restore) { return put(kind, { ...records.get(id), deletedAt: restore ? null : now() }, id); }
export async function suitePlan(s) { return get(s.planId, 'plan'); }
export async function job(id) { return structuredClone(tasks.get(id)); }
export async function jobs(ids) { return [...tasks.values()].filter(j => !ids || ids.includes(j.payload.projectId)); }
export async function enqueue(kind, payload) { const j = { id: randomUUID(), kind, payload, status: 'queued', created: now() }; tasks.set(j.id, j); return structuredClone(j); }
