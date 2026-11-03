import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

test('personnel organization tree promotes empty levels, indents under CSP, filters users and preserves collapsed state', { timeout: 45000 }, async () => {
    const users = [
        { id: 'u0', username: 'rootuser', displayName: '直属人员', company: '', department: '', section: '', role: 'viewer', enabled: true },
        { id: 'u1', username: 'fulluser', displayName: '完整人员', company: '公司甲', department: '信息部', section: '质控处', role: 'tester', enabled: true },
        { id: 'u2', username: 'companyuser', displayName: '公司直属', company: '公司甲', department: '', section: '', role: 'viewer', enabled: true },
        { id: 'u3', username: 'departmentuser', displayName: '部门直属', company: '公司甲', department: '信息部', section: '', role: 'viewer', enabled: false },
        { id: 'u4', username: 'orphanuser', displayName: '孤立部门人员', company: '', department: '运营部', section: '', role: 'viewer', enabled: true },
        { id: 'u5', username: 'sectionuser', displayName: '跨级人员', company: '公司甲', department: '', section: '直接处室', role: 'viewer', enabled: true }
    ];
    const state = { me: { id: 'admin', role: 'admin', enabled: true, ownedProjectIds: ['p'], projectIds: [] }, projects: [{ id: 'p', name: '项目', ownerId: 'admin', baseURL: 'http://fixture', entry: '/', auth: false }], plans: [], suites: [], evidence: [], jobs: [], workers: [], model: { configured: false }, trash: { plans: [], suites: [] } };
    let savedMembers = null, imported = null, edited = null;
    const memberUsers = [...users.map(u => ({ ...u, domainAccount: u.username, role: 'viewer' })), { id: 'u6', domainAccount: 'othercompany', displayName: '同名异公司', company: '公司乙', department: '信息部', section: '质控处', enabled: true, role: 'viewer' }, { id: 'u7', domainAccount: 'owner', displayName: '所有者', company: '公司甲', department: '信息部', section: '质控处', enabled: true, owner: true }, { id: 'u8', domainAccount: 'administrator', displayName: '管理员', company: '公司甲', department: '信息部', section: '质控处', enabled: true, globalAdmin: true }];
    const server = http.createServer(async (req, res) => {
        try {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = raw ? JSON.parse(raw) : null;
            if (req.method === 'PUT') savedMembers = body;
            if (req.url === '/api/users/import') imported = body;
            if (req.method === 'PATCH') edited = body;
            if (req.url.startsWith('/api/')) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(req.url === '/api/state' ? state : req.url === '/api/users' ? users : req.url.endsWith('/members') ? { version: '1', users: memberUsers } : req.url === '/api/users/import' ? { total: 1, created: 1, updated: 0, failed: 0, rows: [{ line: 2, domainAccount: 'templateuser', status: 'created' }] } : { ok: true })); return;
            }
            const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/personnel-ui.css': 'personnel-ui.css', '/favicon.svg': 'favicon.svg' }[req.url];
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'");
            res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
            res.end(await readFile('public/' + file));
        } catch (e) { res.statusCode = 500; res.end(e.message); }
    }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-zygote', '--disable-gpu'] } : {}) });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []; page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
        await page.goto('http://127.0.0.1:' + server.address().port); await page.getByRole('button', { name: '人员管理', exact: true }).click();
        await expect(page.locator('.personnel-table tbody tr')).toHaveCount(6); await page.waitForFunction(() => !!document.getElementById('personnel-styles')?.sheet); await expect(page.locator('.org-tree')).not.toContainText('未分配');
        const org = page.locator('.personnel-org .org-tree');
        await expect(org.locator(':scope > .org-person')).toHaveCount(1); await expect(org.locator(':scope > .org-person')).toContainText('直属人员');
        const company = org.locator(':scope > details.org-node').filter({ hasText: '公司甲' });
        await expect(company.locator(':scope > .org-children > .org-person')).toContainText('公司直属');
        const dept = company.locator(':scope > .org-children > details.org-node').filter({ hasText: '信息部' });
        await expect(dept.locator(':scope > .org-children > .org-person')).toContainText('部门直属');
        const section = dept.locator(':scope > .org-children > details.org-node');
        const x1 = (await company.locator(':scope > summary').boundingBox()).x, x2 = (await dept.locator(':scope > summary').boundingBox()).x, x3 = (await section.locator(':scope > summary').boundingBox()).x;
        assert.ok(x2 > x1 + 10 && x3 > x2 + 10, 'nested organizations must have visible CSS indentation');
        await expect(company.locator(':scope > .org-children > details.org-node').filter({ hasText: '直接处室' })).toHaveCount(1);
        await expect(org.locator(':scope > details.org-node').filter({ hasText: '运营部' })).toHaveCount(1);
        await page.screenshot({ path: '/tmp/personnel-ui-new.png', fullPage: true });
        await dept.locator(':scope > summary > button').click(); await expect(page.locator('.personnel-table tbody tr')).toHaveCount(2);
        await org.locator('button[data-id="u0"]').click(); await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1); await expect(page.locator('.personnel-table')).toContainText('直属人员');
        await page.getByRole('button', { name: /^全部人员/ }).click(); await page.getByLabel('账号 / 姓名 / 组织').fill('孤立'); await page.getByRole('button', { name: '查询', exact: true }).click(); await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1); await expect(page.locator('.personnel-table')).toContainText('孤立部门人员');
        await page.getByRole('button', { name: '重置', exact: true }).click(); await page.getByLabel('状态', { exact: true }).selectOption('disabled'); await page.getByRole('button', { name: '查询', exact: true }).click(); await expect(page.locator('.personnel-table')).toContainText('部门直属'); await expect(page.locator('.personnel-table tbody tr')).toHaveCount(1);
        await page.getByRole('button', { name: '重置', exact: true }).click(); await company.locator(':scope > summary > .org-chevron').click(); await expect(company).not.toHaveAttribute('open', '');
        await page.waitForResponse(r => r.url().endsWith('/api/state') && r.ok()); await expect(company).not.toHaveAttribute('open', '');
        await page.setViewportSize({ width: 850, height: 1000 }); assert.equal(await page.locator('.personnel-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
        await page.getByRole('button', { name: '项目与环境', exact: true }).click(); await page.getByRole('button', { name: '项目成员', exact: true }).click(); await expect(page.locator('#modal .org-tree')).not.toContainText('未分配'); await expect(page.locator('#modal .org-tree > .org-person')).toContainText('直属人员');
        // Bulk authorization uses a complete organization path and saves only on submit.
        const select = account => page.getByLabel(account + ' 项目权限', { exact: true });
        await page.locator('#member-batch-apply').click(); await expect(page.locator('#member-batch-result')).toContainText('请先选择');
        const deptOption = page.locator('#member-batch-org option').filter({ hasText: '公司甲 / 信息部（部门' });
        await page.locator('#member-batch-org').selectOption(await deptOption.getAttribute('value'));
        await page.locator('#member-batch-role').selectOption('editor'); await page.locator('#member-batch-apply').click();
        await expect(select('fulluser')).toHaveValue('editor'); await expect(select('departmentuser')).toBeDisabled(); await expect(select('othercompany')).toHaveValue('viewer'); await expect(select('companyuser')).toHaveValue('viewer'); assert.equal(savedMembers, null);
        const sectionOption = page.locator('#member-batch-org option').filter({ hasText: '公司甲 / 信息部 / 质控处（处室' });
        await page.locator('#member-batch-org').selectOption(await sectionOption.getAttribute('value')); await page.locator('#member-batch-role').selectOption(''); await page.locator('#member-batch-apply').click(); await expect(select('fulluser')).toHaveValue('');
        // Manual overrides remain possible after a batch action.
        await select('fulluser').selectOption('editor'); await page.getByRole('button', { name: '保存成员权限', exact: true }).click(); await expect(page.locator('#modal')).not.toBeVisible();
        assert.equal(savedMembers.version, '1'); assert.equal(savedMembers.members.find(m => m.userId === 'u1').role, 'editor'); assert.equal(savedMembers.members.find(m => m.userId === 'u6').role, 'viewer'); assert.ok(!savedMembers.members.some(m => ['u3', 'u7', 'u8'].includes(m.userId)));
        await page.getByRole('button', { name: '人员管理', exact: true }).click();
        await page.locator('.personnel-table tbody tr').filter({ hasText: '完整人员' }).getByRole('button', { name: '编辑 / 重置密码' }).click();
        const companyInput = page.getByLabel('公司', { exact: true }), departmentInput = page.getByLabel('部门', { exact: true }), sectionInput = page.getByLabel('处室', { exact: true });
        // Existing values must not prevent a click from opening the full suggestion list.
        await companyInput.click(); await expect(page.getByRole('listbox', { name: '公司选项', exact: true })).toBeVisible();
        await expect(page.locator('#org-options-company [role="option"]')).toHaveText(['公司甲']);
        await page.getByRole('option', { name: '公司甲', exact: true }).click(); await expect(companyInput).toHaveValue('公司甲'); await expect(companyInput).toHaveAttribute('aria-expanded', 'false');
        await page.getByRole('button', { name: '展开部门选项', exact: true }).click(); await expect(page.getByRole('listbox', { name: '部门选项', exact: true })).toBeVisible();
        await expect(page.locator('#org-options-department [role="option"]')).toHaveText(['信息部']); await page.getByRole('option', { name: '信息部', exact: true }).click();
        await sectionInput.click(); await expect(page.locator('#org-options-section [role="option"]')).toHaveText(['质控处']); await sectionInput.press('ArrowDown'); await sectionInput.press('Enter'); await expect(sectionInput).toHaveValue('质控处'); await expect(sectionInput).toHaveAttribute('aria-expanded', 'false');
        await companyInput.fill('不存在'); await expect(page.locator('#org-options-company')).toContainText('暂无匹配组织');
        // Clicking an already-filled field shows all candidates again, without clearing it.
        await companyInput.click(); await expect(page.locator('#org-options-company [role="option"]')).toHaveText(['公司甲']); await companyInput.press('Escape'); await expect(companyInput).toHaveAttribute('aria-expanded', 'false');
        await companyInput.fill(''); await departmentInput.click(); await expect(page.locator('#org-options-department [role="option"]')).toHaveText(['信息部', '运营部']);
        await departmentInput.press('ArrowUp'); await departmentInput.press('Enter'); await expect(departmentInput).toHaveValue('运营部');
        await page.getByRole('button', { name: '展开公司选项', exact: true }).click(); await page.getByRole('button', { name: '展开公司选项', exact: true }).click(); await expect(companyInput).toHaveAttribute('aria-expanded', 'false');
        await companyInput.click(); await page.getByLabel('姓名', { exact: true }).click(); await expect(companyInput).toHaveAttribute('aria-expanded', 'false');
        await companyInput.fill('新公司'); await departmentInput.fill('新部门'); await sectionInput.fill('新处室'); await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.locator('#modal')).not.toBeVisible(); assert.equal(edited.company, '新公司'); assert.equal(edited.department, '新部门'); assert.equal(edited.section, '新处室');
        await page.getByRole('button', { name: '导入人员', exact: true }).click();
        const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '下载导入模板（CSV）' }).click(); const download = await downloadPromise;
        assert.equal(download.suggestedFilename(), 'TestHub-人员导入模板.csv'); const template = await readFile(await download.path()); assert.equal(template.subarray(0, 3).toString('hex'), 'efbbbf'); assert.equal(template.toString('utf8'), '\uFEFF域账号,公司,部门,处室,姓名\r\n');
        await page.locator('#personnel-file').setInputFiles({ name: 'filled.csv', mimeType: 'text/csv', buffer: Buffer.concat([template, Buffer.from('templateuser,公司甲,信息部,质控处,模板人员\r\n')]) }); await page.locator('[name=initialPassword]').fill('123456'); await page.locator('.modal-footer').getByRole('button', { name: '导入人员', exact: true }).click(); await page.getByRole('heading', { name: '人员导入结果' }).waitFor(); assert.ok(imported.csv.includes('templateuser,公司甲,信息部,质控处,模板人员')); assert.equal(imported.initialPassword, '123456');
        assert.deepEqual(errors, []);
    } finally { await browser.close(); await new Promise(r => server.close(r)); }
});
