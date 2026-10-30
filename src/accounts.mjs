import { randomUUID } from 'node:crypto';
import { query, pool, now } from './db.mjs';
import { accountInput, hashPassword, verifyPassword, publicAccount, deny } from './access.mjs';
const decode = r => r ? { id: r.id, username: r.username, domainAccount: r.username, ...JSON.parse(r.profile_json || '{}'), displayName: r.display_name, role: r.role, enabled: !!r.enabled, projectIds: JSON.parse(r.project_ids), passwordHash: r.password_hash, sessionVersion: r.session_version, created: r.created, updated: r.updated } : null;
export async function initAccounts(password) {
    await query(`CREATE TABLE IF NOT EXISTS users(id VARCHAR(36) PRIMARY KEY,username VARCHAR(64) NOT NULL UNIQUE,display_name VARCHAR(100) NOT NULL,role VARCHAR(16) NOT NULL,enabled TINYINT NOT NULL,project_ids LONGTEXT NOT NULL,password_hash VARCHAR(255) NOT NULL,session_version INT NOT NULL DEFAULT 1,created CHAR(24) NOT NULL,updated CHAR(24) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    // Existing users retain their accounts; add only organization metadata.
    if (!(await query("SHOW COLUMNS FROM users LIKE 'profile_json'")).length) { try { await query('ALTER TABLE users ADD COLUMN profile_json LONGTEXT NULL'); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; } }
    if (!(await query('SELECT id FROM users LIMIT 1')).length) {
        const hash = await hashPassword(password), t = now();
        await query("INSERT IGNORE INTO users(id,username,display_name,role,enabled,project_ids,password_hash,created,updated) VALUES(?,'admin','管理员','admin',1,'[]',?,?,?)", [randomUUID(), hash, t, t]);
    }
}
export async function userById(id) { return decode((await query('SELECT * FROM users WHERE id=?', [id]))[0]); }
export async function listUsers() { return (await query('SELECT * FROM users ORDER BY created,username')).map(r => publicAccount(decode(r))); }
export async function authenticate(username, password) {
    const user = decode((await query('SELECT * FROM users WHERE username=?', [String(username || 'admin').trim().toLowerCase()]))[0]);
    if (!user || !await verifyPassword(password, user.passwordHash) || !user.enabled) deny('账号或密码不正确，或账号已停用', 401);
    return user;
}
export async function saveUser(input, { id, version, actorId } = {}) {
    const value = accountInput(input), passwordHash = input.password ? await hashPassword(input.password) : null;
    if (!id && !passwordHash) deny('新账号必须设置初始密码', 400);
    const c = await pool.getConnection();
    try {
        await c.beginTransaction();
        // Serialize account changes so concurrent demotions cannot remove the last admin.
        const [rows] = await c.execute('SELECT * FROM users ORDER BY id FOR UPDATE');
        const old = id ? decode(rows.find(r => r.id === id)) : null;
        if (id && !old) deny('账号不存在', 404);
        if (old && old.updated !== version) deny('账号已变化，请刷新', 409);
        if (old && value.username !== old.username) deny('账号名不可修改', 400);
        if (old && old.id === actorId && (!value.enabled || value.role !== 'admin')) deny('不能停用或降低当前管理员自身权限', 400);
        if (old?.role === 'admin' && old.enabled && (!value.enabled || value.role !== 'admin') && !rows.some(r => r.id !== id && r.role === 'admin' && r.enabled)) deny('至少保留一名启用的管理员', 409);
        for (const key of ['company', 'department', 'section']) if (old && input[key] === undefined) value[key] = old[key] || '';
        const profile = JSON.stringify({ company: value.company, department: value.department, section: value.section });
        const t = new Date(Math.max(Date.now(), old ? Date.parse(old.updated) + 1 : 0)).toISOString();
        if (old) await c.execute('UPDATE users SET display_name=?,role=?,enabled=?,project_ids=?,password_hash=?,profile_json=?,session_version=session_version+1,updated=? WHERE id=?', [value.displayName, value.role, value.enabled ? 1 : 0, JSON.stringify(value.projectIds), passwordHash || old.passwordHash, profile, t, id]);
        else { id = randomUUID(); await c.execute('INSERT INTO users(id,username,display_name,role,enabled,project_ids,password_hash,created,updated,profile_json) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, value.username, value.displayName, value.role, value.enabled ? 1 : 0, JSON.stringify(value.projectIds), passwordHash, t, t, profile]); }
        await c.commit(); return publicAccount({ ...old, ...value, id, created: old?.created || t, updated: t });
    } catch (e) { await c.rollback(); if (e.code === 'ER_DUP_ENTRY') deny('账号名已存在', 409); throw e; } finally { c.release(); }
}
export async function changePassword(user, oldPassword, password) {
    if (!await verifyPassword(oldPassword, user.passwordHash)) deny('原密码不正确', 400);
    const hash = await hashPassword(password);
    const result = await query('UPDATE users SET password_hash=?,session_version=session_version+1,updated=? WHERE id=? AND session_version=?', [hash, now(), user.id, user.sessionVersion]);
    if (result.affectedRows !== 1) deny('账号已变化，请重新登录', 409);
}
