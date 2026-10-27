import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
test('plan actions live inside editor; single-case edit preserves sibling and shared sections', { timeout: 30000 }, async () => {
    const original = '# 人员管理\n公共规则\n### TC-01 查询\n步骤一\n#### 预期\n返回人员\n### TC-02 重置\n清空条件\n## 测试数据\n保留公共数据\n';
    const plan = { id: 'plan', projectId: 'p', name: '人员管理', content: original, updated: 'v1', approved: true }, calls = [];
    const state = { projects: [{ id: 'p', name: 'GCS' }], plans: [plan], suites: [], jobs: [], workers: [], model: { configured: true }, evidence: [] };
    const server = http.createServer(async (req, res) => {
        try {
            let raw = ''; for await (const b of req) raw += b;
            if (req.url.startsWith('/api/')) { const body = JSON.parse(raw || '{}'); calls.push({ url: req.url, method: req.method, body }); res.setHeader('Content-Type', 'application/json'); if (req.url === '/api/plans/plan' && req.method === 'PUT') Object.assign(plan, body, { approved: false, updated: 'v2' }); res.end(JSON.stringify(req.url === '/api/state' ? state : { ok: true })); return; }
            const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' }[req.url]; res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile('public/' + file));
        } catch (e) { res.statusCode = 500; res.end(e.message); }
    }); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-zygote', '--disable-gpu'] } : {}) });
    try {
        const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('http://127.0.0.1:' + server.address().port); await page.getByRole('button', { name: '测试计划', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '标注 / 重命名', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '删除', exact: true }).count(), 0);
        await page.getByRole('button', { name: '查看 / 编辑', exact: true }).click(); await page.getByRole('button', { name: '标注 / 重命名', exact: true }).waitFor(); await page.getByRole('button', { name: '删除', exact: true }).waitFor(); await page.getByRole('button', { name: '单用例管理', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '查看 / 编辑此用例', exact: true }).count(), 2); await page.getByRole('button', { name: '查看 / 编辑此用例', exact: true }).first().click();
        assert.match(await page.getByLabel('单用例内容').inputValue(), /#### 预期/); assert.doesNotMatch(await page.getByLabel('单用例内容').inputValue(), /TC-02/);
        await page.getByLabel('单用例内容').fill('### TC-01 查询\n修订步骤\n#### 预期\n返回匹配人员'); await page.screenshot({ path: '/tmp/testhub132-plan-editor.png' }); await page.getByRole('button', { name: '保存为待审核', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#modal').open);
        const saved = calls.find(c => c.method === 'PUT').body; assert.equal(saved.version, 'v1'); assert.equal(saved.content, original.replace('步骤一\n#### 预期\n返回人员', '修订步骤\n#### 预期\n返回匹配人员')); assert.equal(plan.approved, false); assert.deepEqual(errors, []);
        await page.getByRole('button', { name: '查看 / 编辑', exact: true }).click(); await page.getByRole('button', { name: '单用例管理', exact: true }).click(); await page.getByRole('button', { name: '查看 / 编辑此用例', exact: true }).last().click(); assert.equal(await page.getByLabel('单用例内容').inputValue(), '### TC-02 重置\n清空条件\n');
    } finally { await browser.close(); await new Promise(r => server.close(r)); }
});
