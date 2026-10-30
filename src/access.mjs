import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export const deny = (message = '无权访问此数据', status = 403) => { throw Object.assign(new Error(message), { status }); };
// Explicit project membership overrides legacy account-level projectIds.
export function projectRole(user, id) {
    if (!user?.enabled || !id) return null;
    if (user.role === 'admin' || ownsProject(user, id)) return 'owner';
    if (user.projectRoles) return user.projectRoles[id] || null;
    return (user.projectIds || []).includes(id) ? (user.role === 'viewer' ? 'viewer' : 'legacy') : null;
}
export function withProjectAccess(user, projects) {
    if (!user) return null;
    const ownedProjectIds = projects.filter(p => p.ownerId === user.id).map(p => p.id);
    const projectRoles = Object.fromEntries(projects.map(p => {
        const member = Array.isArray(p.members) ? p.members.find(m => m.userId === user.id) : null;
        const role = Array.isArray(p.members) ? (['editor', 'viewer'].includes(member?.role) ? member.role : null)
            : (user.projectIds || []).includes(p.id) ? (user.role === 'viewer' ? 'viewer' : 'legacy') : null;
        return [p.id, role];
    }).filter(([, role]) => role));
    return { ...user, ownedProjectIds, projectRoles };
}
export function canProject(user, id) { return !!projectRole(user, id); }
export function ownsProject(user, id) { return !!user?.enabled && !!id && (user.ownedProjectIds || []).includes(id); }
export function requireExecution(user, id) { if (!['owner', 'editor'].includes(projectRole(user, id))) deny('此操作需要项目所有者或协作者权限'); }
export function requireProject(user, id) { if (!canProject(user, id)) deny('记录不存在或无权访问', 404); }
export function requireAdmin(user) { if (user?.role !== 'admin' || !user.enabled) deny('此操作需要管理员权限'); }
export function requireProjectManager(user, id) { if (!user?.enabled || (user.role !== 'admin' && !ownsProject(user, id))) deny('仅管理员和项目所有者可管理成员'); }
export function mayRunJob(user, job) {
    const role = projectRole(user, job.payload.projectId);
    return !!role && role !== 'viewer' && (!(['validate'].includes(job.kind) || job.payload.liveValidation) || ['owner', 'editor'].includes(role));
}
export function permitRoute(user, method, path, projectId) {
    if (!user?.enabled) deny('账号已停用', 401);
    if (user.role === 'admin') return;
    if (path === '/api/logout' || path === '/api/me/password') return;
    if (path.startsWith('/api/users')) deny('人员管理仅限管理员');
    if (/^\/api\/projects\/[\w-]+\/members$/.test(path)) { requireProjectManager(user, projectId || path.split('/')[3]); return; }
    if (method === 'GET' || method === 'HEAD') return;
    if (/^\/api\/jobs\/[\w-]+\/report-link$/.test(path) && method === 'POST') return;
    if (path === '/api/projects' && method === 'POST') return;
    const role = projectRole(user, projectId);
    if (['owner', 'editor'].includes(role)) return;
    if (role === 'viewer' || user.role === 'viewer') deny('当前项目仅有只读权限');
    // Preserve legacy tester restrictions until an owner sets explicit membership.
    if (path === '/api/validate' || /^\/api\/suites\/[\w-]+\/approve$/.test(path)) deny('此操作需要项目所有者或协作者权限');
    if (path.startsWith('/api/projects') || path.startsWith('/api/login-sessions')) deny('项目环境和登录态需要项目所有者或协作者权限');
}
export function accountInput(b) {
    const username = String(b.domainAccount || b.username || '').trim().toLowerCase(), displayName = String(b.displayName || '').trim();
    if (!/^[a-z0-9][a-z0-9_.@\\-]{2,63}$/.test(username)) deny('域账号需为 3–64 位字母、数字或 . _ - @ 反斜线', 400);
    if (!displayName || displayName.length > 100) deny('姓名必填，最多 100 字', 400);
    if (!['admin', 'tester', 'viewer'].includes(b.role)) deny('角色不正确', 400);
    if (!Array.isArray(b.projectIds) || b.projectIds.some(x => typeof x !== 'string') || b.projectIds.length > 1000) deny('项目权限格式不正确', 400);
    const organization = {}; for (const key of ['company', 'department', 'section']) { const value = String(b[key] || '').trim(); if (value.length > 100) deny('组织名称最多 100 字', 400); organization[key] = value; }
    return { username, domainAccount: username, ...organization, displayName, role: b.role, enabled: b.enabled !== false, projectIds: [...new Set(b.projectIds)] };
}
export async function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) deny('密码需为 6–256 个字符', 400);
    const salt = randomBytes(16).toString('hex'), key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || password.length > 256) return false;
    const [scheme, salt, hex] = String(hash || '').split('$'); if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(hex || '')) return false;
    const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), expected = Buffer.from(hex, 'hex');
    return key.length === expected.length && timingSafeEqual(key, expected);
}
export function publicAccount(row) { if (!row) return null; const { passwordHash, sessionVersion, ...safe } = row; return safe; }
