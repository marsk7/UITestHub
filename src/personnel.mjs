import { accountInput, deny } from './access.mjs';
import { listUsers, saveUser } from './accounts.mjs';
// UTF-8 CSV; quoted fields, escaped quotes, BOM, CRLF and embedded newlines.
export function parsePersonnelCsv(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1_000_000) deny('CSV 文件需小于 1MB', 400);
  const text = source.replace(/^\uFEFF/, ''); let rows = [], row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += ch; continue; }
    if (ch === '"') { if (field || closed) deny('CSV 引号格式不正确', 400); quoted = true; continue; }
    if (ch === ',' || ch === '\n' || ch === '\r') { row.push(field.trim()); field = ''; closed = false; if (ch !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; } continue; }
    if (closed && ch.trim()) deny('CSV 引号后只能是分隔符', 400); if (!closed) field += ch;
  }
  if (quoted) deny('CSV 引号未闭合', 400); row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  const header = rows.shift() || [], required = ['域账号', '公司', '部门', '处室', '姓名'];
  if (required.some(h => header.filter(x => x === h).length !== 1)) deny('表头必须包含且不能重复：' + required.join('、'), 400);
  if (!rows.length || rows.length > 200) deny('一次导入 1–200 人', 400);
  const seen = new Set(); return rows.map((r, index) => {
    if (r.length !== header.length) deny('第 ' + (index + 2) + ' 行列数不正确', 400);
    const values = Object.fromEntries(header.map((h, i) => [h, r[i]])); if (required.some(h => !values[h])) deny('第 ' + (index + 2) + ' 行必填字段为空', 400);
    const value = accountInput({ domainAccount: values['域账号'], displayName: values['姓名'], company: values['公司'], department: values['部门'], section: values['处室'], role: 'viewer', projectIds: [] });
    if (seen.has(value.username)) deny('CSV 内域账号重复：' + value.username, 400); seen.add(value.username); return { ...value, line: index + 2 };
  });
}
export async function importPersonnel(csv, initialPassword, actorId, onSaved = async () => { }) {
  const rows = parsePersonnelCsv(csv), users = await listUsers(), existing = new Map(users.map(u => [u.username, u]));
  if (rows.some(r => !existing.has(r.username)) && (typeof initialPassword !== 'string' || initialPassword.length < 6 || initialPassword.length > 256)) deny('新增人员的初始密码需为 6–256 位', 400);
  const result = [];
  // Each row has its own transaction; report partial failures instead of claiming all-or-nothing.
  for (const row of rows) {
    const old = existing.get(row.username); try {
      const input = { ...row, role: old?.role || 'viewer', enabled: old?.enabled ?? true, projectIds: old?.projectIds || [] };
      if (!old) input.password = initialPassword;
      const saved = await saveUser(input, { id: old?.id, version: old?.updated, actorId }); await onSaved(saved.id);
      result.push({ line: row.line, domainAccount: row.username, status: old ? 'updated' : 'created' });
    } catch (e) { result.push({ line: row.line, domainAccount: row.username, status: 'failed', error: e.status ? e.message : '保存失败，请检查服务器日志' }); }
  }
  return { total: rows.length, created: result.filter(r => r.status === 'created').length, updated: result.filter(r => r.status === 'updated').length, failed: result.filter(r => r.status === 'failed').length, rows: result };
}
export function memberDirectory(users, project) {
  return users.filter(u => u.enabled || u.id === project.ownerId || project.members?.some(m => m.userId === u.id)).map(u => ({
    id: u.id, domainAccount: u.username, displayName: u.displayName, company: u.company || '', department: u.department || '', section: u.section || '', enabled: u.enabled, globalAdmin: u.role === 'admin', owner: u.id === project.ownerId,
    role: u.id === project.ownerId ? 'owner' : Array.isArray(project.members) ? project.members.find(m => m.userId === u.id)?.role || '' : u.projectIds.includes(project.id) ? (u.role === 'viewer' ? 'viewer' : 'editor') : ''
  }));
}
export function validateMembers(input, users, project) {
  if (!Array.isArray(input) || input.length > 1000) deny('成员格式不正确', 400);
  const seen = new Set(); return input.map(m => {
    if (!m || typeof m.userId !== 'string' || seen.has(m.userId) || !['editor', 'viewer'].includes(m.role)) deny('成员重复或权限不正确', 400);
    const user = users.find(u => u.id === m.userId); if (!user || !user.enabled) deny('成员不存在或已停用', 400);
    if (m.userId === project.ownerId) deny('所有者不需要添加为成员', 400);
    seen.add(m.userId); return { userId: m.userId, role: m.role };
  });
}
