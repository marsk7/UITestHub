import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyGeneratedCase, verificationSettings, classifyFailure, generationOutcome } from '../src/generation-verifier.mjs';
import { generateAll } from '../src/generation.mjs';
import { generateWithRecovery } from '../src/suite-workflow.mjs';
import { mergeEvidence } from '../src/locator-evidence.mjs';
import { checkAssertionContract } from '../src/assertion-contract.mjs';
const manifest = [{ id: 'TC-01', title: '查询' }, { id: 'TC-02', title: '缺口' }, { id: 'TC-03', title: '后续' }];
const block = t => `test('${'[' + t.id + '] ' + t.title}',async({page})=>{await page.goto('/');await expect(page.getByText('人员管理')).toBeVisible();});`;
test('live verification requires explicit execution opt-in; old clients stay static', () => {
    assert.throws(() => verificationSettings({ liveValidation: true }), /确认/);
    assert.equal(verificationSettings({}).liveValidation, false);
    assert.equal(verificationSettings({ liveValidation: true, executionConfirmed: true }).liveValidation, true);
});
test('failed browser validation retains code, all later cases and separate coverage', async () => {
    const seen = [], journal = [];
    const result = await generateAll({ manifest, evidence: { controls: [] }, liveValidation: true, executionConfirmed: true }, { ask: async (_, p) => JSON.stringify(p.target.id === 'TC-02' ? { code: '', gaps: ['缺少字段定位'] } : { code: block(p.target), gaps: [] }), verify: async ({ target }) => { seen.push(target.id); return { ...target, status: target.id === 'TC-01' ? 'failed' : 'passed', errors: ['fixture'] }; }, onCase: async r => journal.push(r) });
    assert.deepEqual(seen, ['TC-01', 'TC-03']); assert.equal(result.coverage.generated, 2); assert.ok(result.code.includes('[TC-01]')); assert.equal(result.generationVerification.summary.failed, 1); assert.equal(result.generationVerification.summary.blocked, 1); assert.equal(result.generationVerification.summary.passed, 1); assert.equal(journal.length, 3); assert.equal(generationOutcome(result, true), 'incomplete'); assert.equal(generationOutcome({ ...result, coverage: { complete: true, expected: 3 } }, true), 'needs-review');
});
test('recovery keeps validated cases and replaces only missing-case ledger entries', async () => {
    let explored = false; const verified = [];
    const result = await generateWithRecovery({ manifest, evidence: { controls: [] }, liveValidation: true, executionConfirmed: true, autoExplore: true }, { ask: async (_, p) => JSON.stringify(p.target.id === 'TC-02' && !explored ? { code: '', gaps: ['缺少字段定位'] } : { code: block(p.target), gaps: [] }), verify: async ({ target }) => { verified.push(target.id); return { ...target, status: 'passed' }; }, explore: async () => { explored = true; return { evidence: { controls: [] } }; } });
    assert.deepEqual(verified, ['TC-01', 'TC-03', 'TC-02']); assert.equal(result.coverage.generated, 3); assert.equal(result.generationVerification.summary.passed, 3); assert.equal(result.generationVerification.summary.blocked, 0); assert.equal(generationOutcome(result, true), 'succeeded');
});
test('assertion failures are not auto-classified as locator repairs; proposal cannot weaken expectations', () => {
    assert.equal(classifyFailure([{ category: 'expect', error: 'locator element not found Timeout' }]), 'assertion');
    const before = "test('x',async({page})=>{await expect(page.locator('a')).toHaveText('必填');});";
    assert.equal(checkAssertionContract(before, before.replace("locator('a')", "locator('b')")).ok, true);
    assert.equal(checkAssertionContract(before, before.replace('必填', '成功')).ok, false);
    assert.equal(checkAssertionContract(before, "test('x',()=>{});").ok, false);
    assert.equal(checkAssertionContract(before, before.replace('expect(', 'expect.soft(')).ok, false);
});
test('evidence merge retains distinct prerequisite paths and isolates environments', () => {
    const c = (name, prerequisites = []) => ({ nameHint: name, candidates: [{ expression: `getByText('${name}')` }], prerequisites });
    const previous = { id: 'a', projectId: 'p', baseURL: 'http://a', controls: [c('默认'), c('展开', ['展开'])] }, current = { id: 'b', projectId: 'p', baseURL: 'http://a', controls: [c('默认'), c('标签', ['标签'])] };
    const merged = mergeEvidence(previous, current); assert.equal(merged.controls.length, 3); assert.equal(merged.controls[1].sourceEvidenceId, 'a'); assert.equal(mergeEvidence(previous, { ...current, baseURL: 'http://b' }).controls.length, 2);
});
test('real Chromium verifies actions, assertions and captures failure evidence without retaining login state', { timeout: 90000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'testhub-verify-'));
    const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<h1>人员管理</h1><button onclick="document.querySelector('section').hidden=false">展开</button><section hidden><label>工号<input></label><button onclick="document.querySelector('p').textContent='No data'">查询</button></section><p></p>`); });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); const project = { baseURL: 'http://127.0.0.1:' + server.address().port };
    const execute = (args, cwd, env, limit) => new Promise((resolve, reject) => { const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x); const timer = setTimeout(() => child.kill('SIGKILL'), limit); child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, output }); }); });
    try {
        const run = async (name, body) => verifyGeneratedCase({ code: `import {test,expect} from '@playwright/test';test('${name}',async({page})=>{await page.goto('/');${body}});`, target: { id: name, title: name }, project, storageState: { cookies: [], origins: [] }, dir: path.join(dir, name), execute });
        const passed = await run('pass', `await page.getByRole('button',{name:'展开'}).click();await page.getByLabel('工号').fill('0000');await page.getByRole('button',{name:'查询',exact:true}).click();await expect(page.locator('p')).toHaveText('No data');`);
        assert.equal(passed.status, 'passed', JSON.stringify(passed)); assert.ok(passed.steps.some(s => /fill/i.test(s.title))); assert.ok(passed.steps.some(s => s.category === 'expect' && s.status === 'passed')); await access(path.join(dir, 'pass/html-report/index.html'));
        const failed = await run('fail', `await expect(page.getByRole('heading')).toHaveText('错误标题',{timeout:200});`);
        assert.equal(failed.status, 'failed'); assert.equal(failed.category, 'assertion'); assert.match(failed.snapshot, /人员管理/); assert.ok(failed.steps.some(s => s.status === 'failed'));
        const locator = await run('locator', `await page.getByRole('button',{name:'不存在'}).click({timeout:200});await expect(page.getByRole('heading')).toBeVisible();`);
        assert.equal(locator.status, 'failed'); assert.equal(locator.category, 'locator');
        for (const name of ['pass', 'fail', 'locator']) { await assert.rejects(access(path.join(dir, name, 'storage.json'))); await assert.rejects(access(path.join(dir, name, 'node_modules'))); }
        const brokenDir = path.join(dir, 'broken'); await assert.rejects(verifyGeneratedCase({ code: "import {test,expect} from '@playwright/test';" + block(manifest[0]), target: manifest[0], project, storageState: { cookies: [], origins: [] }, dir: brokenDir, execute: async () => { throw new Error('fixture launch failure'); } }), /launch failure/); await assert.rejects(access(path.join(brokenDir, 'storage.json')));
    } finally { await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
});
