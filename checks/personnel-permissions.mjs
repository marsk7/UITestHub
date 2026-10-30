import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { parsePersonnelCsv } from '../src/personnel.mjs';
import { withProjectAccess, canProject, projectRole, permitRoute, mayRunJob, requireExecution } from '../src/access.mjs';

test('CSV supports UTF-8 BOM, quoted names, domain formats and fails before writes on malformed input', () => {
    const rows = parsePersonnelCsv('\uFEFF域账号,公司,部门,处室,姓名\r\nEXAMPLE\\zhangsan,示例公司,信息管理部,质量控制处,"张,三"\r\nli.si@example.com,示例公司,信息管理部,质量控制处,李四');
    assert.equal(rows[0].username, 'example\\zhangsan'); assert.equal(rows[0].displayName, '张,三'); assert.equal(rows[1].username, 'li.si@example.com');
    assert.throws(() => parsePersonnelCsv('域账号,公司,部门,处室,姓名\naaa,A,B,C,甲\nAAA,A,B,C,乙'), /重复/);
    assert.throws(() => parsePersonnelCsv('域账号,公司,部门,处室,姓名\naaa,A,B,,甲'), /必填/);
    assert.throws(() => parsePersonnelCsv('域账号,公司,部门,处室,姓名\naaa,A,B,C,"甲'), /引号/);
});
test('explicit membership overrides legacy grants and platform viewer role; jobs recheck current access', () => {
    const base = { id: 'u', enabled: true, role: 'viewer', projectIds: ['p'] };
    let user = withProjectAccess(base, [{ id: 'p', ownerId: 'other', members: [{ userId: 'u', role: 'editor' }] }]);
    assert.equal(projectRole(user, 'p'), 'editor'); assert.doesNotThrow(() => requireExecution(user, 'p')); assert.equal(mayRunJob(user, { kind: 'validate', payload: { projectId: 'p' } }), true);
    assert.throws(() => permitRoute(user, 'PUT', '/api/projects/p/members', 'p'), /所有者/);
    user = withProjectAccess(base, [{ id: 'p', ownerId: 'other', members: [] }]); assert.equal(canProject(user, 'p'), false); assert.equal(mayRunJob(user, { kind: 'run', payload: { projectId: 'p' } }), false);
    user = withProjectAccess({ ...base, role: 'tester' }, [{ id: 'p', ownerId: 'other', members: [{ userId: 'u', role: 'viewer' }] }]); assert.throws(() => permitRoute(user, 'POST', '/api/plans', 'p'), /只读/);
    user = withProjectAccess(base, [{ id: 'p', ownerId: 'u', members: [] }]); assert.equal(projectRole(user, 'p'), 'owner'); assert.doesNotThrow(() => permitRoute(user, 'PUT', '/api/projects/p/members', 'p'));
});
test('actual Worker cancellation function honors project collaborators and revocation', async () => {
    const source = await readFile(new URL('../src/worker.mjs', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('worker.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'taskCancelled'); assert.ok(node);
    const project = { id: 'p', ownerId: 'owner', members: [{ userId: 'u', role: 'editor' }] }, user = { id: 'u', enabled: true, role: 'viewer', projectIds: [] };
    const updates = [], logs = [], context = { stopping: false, job: async () => ({ cancel: false }), get: async () => project, userById: async () => user, withProjectAccess, mayRunJob, query: async (...a) => updates.push(a), log: async (...a) => logs.push(a) };
    const task = vm.runInNewContext('(' + node.getText(ast) + ')', context), j = { id: 'job', kind: 'validate', payload: { projectId: 'p', requestedBy: 'u' } };
    assert.equal(await task(j), false);
    project.members[0].role = 'viewer'; assert.equal(await task(j), true); assert.ok(updates[0][0].includes('cancel=1')); assert.ok(logs.length);
    project.members = []; assert.equal(await task({ ...j, kind: 'run' }), true);
    project.ownerId = 'u'; assert.equal(await task(j), false);
    user.enabled = false; assert.equal(await task(j), true);
});
test('HTTP import, organization persistence, ownership, collaborator workflow, readonly and immediate report revocation', { timeout: 30000 }, async () => {
    const data = await mkdtemp(join(tmpdir(), 'testhub-personnel-')), socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
    const child = spawn(process.execPath, ['--import', './checks/fixtures/http-loader.mjs', 'src/server.mjs'], { env: { ...process.env, ADMIN_PASSWORD: '123456', DATA_DIR: data, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }); let logs = ''; child.stderr.on('data', b => logs += b);
    try {
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(logs || 'start timeout')), 10000); child.stdout.on('data', b => { if (String(b).includes('listening')) { clearTimeout(timer); resolve(); } }); child.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); }); });
        const base = 'http://127.0.0.1:' + port;
        async function call(path, method = 'GET', body, cookie) { const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] }; }
        const login = async username => (await call('/login', 'POST', { username, password: '123456' })).cookie;
        const admin = await login('admin'); const csv = '域账号,公司,部门,处室,姓名\nowner001,公司甲,信息部,质控处,张三\nmember001,公司甲,信息部,质控处,李四\nother001,公司乙,人资部,招聘处,王五';
        const imp = await call('/users/import', 'POST', { csv, initialPassword: '123456' }, admin); assert.equal(imp.status, 200, JSON.stringify(imp)); assert.equal(imp.data.created, 3);
        let users = (await call('/users', 'GET', undefined, admin)).data; const owner = users.find(u => u.username === 'owner001'), member = users.find(u => u.username === 'member001'); assert.equal(member.role, 'viewer'); assert.equal(member.company, '公司甲'); assert.equal(member.section, '质控处'); assert.equal(member.passwordHash, undefined);
        let oc = await login('owner001'), mc = await login('member001'), xc = await login('other001');
        assert.equal((await call('/users/import', 'POST', { csv }, oc)).status, 403);
        const p = (await call('/projects', 'POST', { name: '自建', baseURL: 'http://fixture', entry: '/' }, oc)).data; assert.equal(p.ownerId, owner.id); assert.deepEqual(p.members, []);
        assert.equal((await call('/projects/' + p.id + '/members', 'GET', undefined, mc)).status, 403); assert.equal((await call('/projects/p2/members', 'GET', undefined, oc)).status, 403);
        const directory = (await call('/projects/' + p.id + '/members', 'GET', undefined, oc)).data; assert.ok(!JSON.stringify(directory).includes('password')); assert.equal(directory.users.find(u => u.id === member.id).projectIds, undefined);
        let grant = await call('/projects/' + p.id + '/members', 'PUT', { version: directory.version, members: [{ userId: member.id, role: 'editor', platformRole: 'admin' }] }, oc); assert.equal(grant.status, 200);
        assert.equal((await call('/projects/' + p.id + '/members', 'PUT', { version: directory.version, members: [] }, oc)).status, 409);
        let state = (await call('/state', 'GET', undefined, mc)).data; assert.equal(state.me.role, 'viewer'); assert.equal(state.me.projectRoles[p.id], 'editor'); assert.ok(state.projects.some(x => x.id === p.id));
        const plan = (await call('/plans', 'POST', { projectId: p.id, name: '查询', content: '### TC-01 查询' }, mc)).data; assert.equal((await call('/plans/' + plan.id + '/approve', 'POST', {}, mc)).status, 200);
        const suite = (await call('/suites', 'POST', { projectId: p.id, name: '脚本', code: "import {test,expect} from '@playwright/test';test('查询',async({page})=>{await expect(page.getByText('标题')).toBeVisible();});" }, mc)).data;
        assert.equal((await call('/suites/' + suite.id + '/approve', 'POST', {}, mc)).status, 200); const run = await call('/runs', 'POST', { suiteId: suite.id }, mc); assert.equal(run.status, 202);
        assert.equal((await call('/projects/' + p.id + '/members', 'PUT', { version: grant.data.version, members: [] }, mc)).status, 403);
        assert.equal((await call('/suites/' + suite.id + '/cases', 'GET', undefined, xc)).status, 404);
        const reportDir = join(data, 'runs', run.data.id, 'html-report'); await mkdir(reportDir, { recursive: true }); await writeFile(join(reportDir, 'index.html'), '<html>report</html>');
        const link = await call('/jobs/' + run.data.id + '/report-link', 'POST', {}, mc); assert.equal(link.status, 200); const reportURL = link.data.url; assert.equal((await fetch(base + reportURL)).status, 200);
        grant = await call('/projects/' + p.id + '/members', 'PUT', { version: grant.data.version, members: [{ userId: member.id, role: 'viewer' }] }, oc); assert.equal(grant.status, 200);
        assert.equal((await call('/plans', 'POST', { projectId: p.id, name: '不能创建', content: 'x' }, mc)).status, 403); assert.equal((await call('/state', 'GET', undefined, mc)).data.projects.length, 1);
        grant = await call('/projects/' + p.id + '/members', 'PUT', { version: grant.data.version, members: [] }, oc); assert.equal(grant.status, 200); assert.equal((await call('/suites/' + suite.id + '/cases', 'GET', undefined, mc)).status, 404); assert.equal((await fetch(base + reportURL)).status, 401);
        // Reimport updates organization only, preserving password, global role and explicit project membership.
        const again = await call('/users/import', 'POST', { csv: '域账号,公司,部门,处室,姓名\nmember001,公司甲,新部门,新处室,李四新', initialPassword: 'other-password' }, admin); assert.equal(again.data.updated, 1); assert.ok(await login('member001')); assert.equal((await call('/login', 'POST', { username: 'member001', password: 'other-password' })).status, 401);
        users = (await call('/users', 'GET', undefined, admin)).data; assert.equal(users.find(u => u.id === member.id).department, '新部门'); assert.equal(users.find(u => u.id === member.id).role, 'viewer');
        const adminState = (await call('/state', 'GET', undefined, admin)).data; assert.ok(adminState.projects.some(x => x.id === p.id));
        // Exercise the actual personnel import and owner/member dialogs in Chromium.
        const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-zygote', '--disable-gpu'] } : {}) });
        try {
            const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
            const loginUI = async username => { await page.goto(base); await page.getByLabel('账号', { exact: true }).fill(username); await page.getByLabel('密码', { exact: true }).fill('123456'); await page.getByRole('button', { name: '登录工作台', exact: true }).click(); await page.getByRole('button', { name: '项目与环境', exact: true }).waitFor(); };
            await loginUI('admin'); await page.getByRole('button', { name: '人员管理', exact: true }).click(); await page.getByRole('button', { name: '导入人员', exact: true }).click();
            await page.locator('[name=csv]').fill('域账号,公司,部门,处室,姓名\nuiimport,公司丙,运营部,运行处,界面导入'); await page.locator('[name=initialPassword]').fill('123456'); await page.getByRole('button', { name: '导入人员', exact: true }).last().click();
            await page.getByRole('heading', { name: '人员导入结果', exact: true }).waitFor(); await expect(page.locator('#modal')).toContainText('新增 1'); await page.locator('.modal-footer').getByRole('button', { name: '关闭', exact: true }).click(); await expect(page.locator('main')).toContainText('界面导入'); await expect(page.locator('main')).toContainText('公司丙');
            await page.getByRole('button', { name: '退出登录', exact: true }).click(); await loginUI('owner001'); await page.getByRole('button', { name: '项目与环境', exact: true }).click(); await page.getByRole('button', { name: '项目成员', exact: true }).click();
            await page.getByLabel('member001 项目权限', { exact: true }).selectOption('editor'); await page.getByRole('button', { name: '保存成员权限', exact: true }).click(); await expect(page.locator('#modal')).not.toBeVisible();
            await page.getByRole('button', { name: '退出登录', exact: true }).click(); await loginUI('member001'); await page.getByRole('button', { name: '项目与环境', exact: true }).click(); await expect(page.getByRole('button', { name: '编辑项目', exact: true })).toHaveCount(1); await expect(page.getByRole('button', { name: '项目成员', exact: true })).toHaveCount(0);
            await page.getByRole('button', { name: '编辑项目', exact: true }).click(); await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible(); assert.deepEqual(errors, []);
        } finally { await browser.close(); }

    } finally { child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); await rm(data, { recursive: true, force: true }); }
});
