import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explore } from '../src/explorer.mjs';
import { checkScript } from '../src/script-check.mjs';
import { generateAll } from '../src/generation.mjs';
test('real iframe, unbound form label, hidden duplicate and empty-state CSS become verified candidates', { timeout: 30000 }, async () => {
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/inner' ? `<div class="ant-form-item"><div class="ant-form-item-label"><label>员工姓名</label></div><input></div><div class="ant-form-item"><label>工号</label><input></div><input placeholder="人员搜索" hidden><input placeholder="人员搜索"><button hidden>查询</button><button>查询</button><div class="ant-empty-description">No data</div>` : '<iframe id="staff-panel" src="/inner"></iframe>'); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); const dir = await mkdtemp(join(tmpdir(), 'locator-evidence-'));
    try {
        const e = await explore({ project: { id: 'p', baseURL: 'http://127.0.0.1:' + server.address().port, entry: '/' }, dir });
        const name = e.controls.find(c => c.contextLabel === '员工姓名' && c.tag === 'input'); assert.equal(name.usable, true); assert.deepEqual(name.framePath, ['iframe[id="staff-panel"]']); assert.ok(name.candidates.some(c => c.count === 1 && c.visible && c.expression.includes('hasText')));
        assert.ok(e.controls.some(c => c.placeholder === '人员搜索' && c.candidates.some(x => x.expression.includes('filter({visible:true})') && x.count === 1 && x.visible)));
        const button = e.controls.find(c => c.role === 'button' && c.nameHint === '查询' && c.visible); assert.ok(button.candidates.some(c => c.count === 1 && c.visible));
        const candidate = button.candidates.find(c => c.count === 1 && c.visible); const code = `test('x',async({page})=>{await page.${candidate.expression}.click();});`; assert.equal(checkScript(code, e).ok, true);
        assert.equal(checkScript("test('x',async({page})=>{await page.getByRole('button',{name:'查询',exact:true}).click();});", e).ok, false);
        const empty = e.controls.find(c => c.emptySelector); assert.ok(empty.candidates.some(c => c.expression.includes('.ant-empty-description') && c.count === 1));
    } finally { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});
test('generator receives the failed response and exact locator error for a bounded repair', async () => {
    let calls = 0; const expression = 'getByRole("button",{"name":"查询","exact":true})', evidence = { controls: [{ candidates: [{ expression, count: 1, visible: true }] }] };
    const result = await generateAll({ manifest: [{ id: 'TC-01', title: '查询' }], evidence }, { ask: async (_, p) => { calls++; if (calls === 2) { assert.match(p.repair.error, /定位/); assert.match(p.repair.previousResponse, /first/); } return JSON.stringify({ code: `test('[TC-01] 查询',async({page})=>{await page.${calls === 1 ? 'getByRole("button",{name:"查询"}).first()' : expression}.click();await expect(page.getByText('结果')).toBeVisible();});`, gaps: [] }); } });
    assert.equal(calls, 2); assert.equal(result.coverage.complete, true); assert.deepEqual(result.gaps, []);
});
