import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { compactEvidence } from '../src/locator-evidence.mjs';
import { generateWithRecovery } from '../src/suite-workflow.mjs';

test('model evidence excludes large result data and retains replayable table structure', () => {
    const c = { expression: 'locator("#rows td")', kind: 'collection', count: 6, visibleCount: 6, visible: true, frameVerified: true };
    const e = { id: 'e', selectedData: 'PRIVATE_EMPLOYEE'.repeat(5000), modelTestData: '输入工号：E001', tables: [{ rows: [['PRIVATE_EMPLOYEE']], nameHint: 'PRIVATE_EMPLOYEE', headers: [{ index: 0, name: '工号' }], container: { ...c, expression: 'locator("#table")', count: 1 }, rowCandidate: c, columns: [{ index: 0, name: '工号', candidate: c }] }], controls: [{ kind: 'table', nameHint: 'PRIVATE_EMPLOYEE', rows: [['PRIVATE_EMPLOYEE']], candidates: [c], stateId: 'state-1', prerequisites: ['page.getByText("展开").click()'] }, { dataRegion: true, tag: 'a', role: 'link', nameHint: 'PRIVATE_EMPLOYEE', candidates: [{ expression: 'getByText("PRIVATE_EMPLOYEE")' }] }, { kind: 'selected-value', nameHint: 'PRIVATE_EMPLOYEE', selectedText: 'PRIVATE_EMPLOYEE', candidates: [c] }] };
    const compact = compactEvidence(e), json = JSON.stringify(compact); assert.ok(json.length < 20000); assert.ok(!json.includes('PRIVATE_EMPLOYEE')); assert.equal(compact.selectedData, '输入工号：E001'); assert.equal(compact.tables[0].columns[0].candidate.kind, 'collection'); assert.equal(compact.controls[0].stateId, 'state-1'); assert.equal(compact.controls[0].prerequisites.length, 1); assert.equal(compactEvidence({ ...e, modelTestData: undefined }).selectedData, ''); assert.ok(!('rows' in compact.tables[0]));
});
test('supplement instruction follows generation, static repair, and recovery exploration', async () => {
    const instruction = '先展开筛选，再搜索目标选项', target = { id: 'TC-01', title: '查询' }; let calls = 0, explored = false;
    const result = await generateWithRecovery({ manifest: [target], generationInstruction: instruction, evidence: { controls: [] }, autoExplore: true }, {
        ask: async (system, p) => { assert.equal(p.generationInstruction, instruction); assert.match(system, /不能据此编造选择器/); calls++; if (calls === 1) return JSON.stringify({ code: '', gaps: ['缺少控件定位'] }); if (calls === 2) return '{bad'; assert.match(p.repair.error, /JSON/); return JSON.stringify({ code: "test('[TC-01] 查询',async({page})=>{await expect(page.getByText('标题')).toBeVisible();});", gaps: [] }); },
        explore: async goals => { assert.match(goals.locatorNotes, /先展开筛选/); explored = true; return { evidence: { controls: [] } }; }
    }); assert.equal(explored, true); assert.equal(calls, 3); assert.equal(result.coverage.complete, true);
});
test('HTTP: optional data, completion instructions, approval without trial and static rejection', { timeout: 20000 }, async () => {
    const data = await mkdtemp(join(tmpdir(), 'testhub133-')), socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
    const child = spawn(process.execPath, ['--import', './checks/fixtures/http-loader.mjs', '--input-type=module', '-e', `import {put} from './checks/fixtures/memory-db.mjs';const e=await put('evidence',{projectId:'p1',baseURL:'http://fixture',entry:'/',capturedAt:new Date().toISOString(),confirmed:true,controls:[],tables:[]},'approval-e');await put('suite',{projectId:'p1',name:'有依据脚本',code:"test('查询',async({page})=>{await expect(page.getByText('标题')).toBeVisible();});",evidenceId:e.id,evidenceVersion:e.updated,gaps:[],validation:{status:'failed'},approved:false},'approval-s');await import('./src/server.mjs');`], { env: { ...process.env, ADMIN_PASSWORD: '123456', DATA_DIR: data, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stderr.on('data', b => out += b);
    try {
        await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(out || 'startup timeout')), 10000); child.stdout.on('data', b => { if (String(b).includes('listening')) { clearTimeout(t); resolve(); } }); child.once('exit', () => { clearTimeout(t); reject(new Error(out)); }); });
        let cookie; const call = async (path, method = 'GET', body) => { const r = await fetch('http://127.0.0.1:' + port + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await r.json(); return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] }; };
        cookie = (await call('/login', 'POST', { password: '123456' })).cookie;
        assert.equal((await call('/suites/approval-s/approve', 'POST', {})).status, 200);
        assert.equal((await call('/runs', 'POST', { suiteId: 'approval-s' })).status, 202);
        const evidence = await call('/evidence/ep1/confirm', 'POST', { rules: '' }); assert.equal(evidence.status, 200); assert.equal(evidence.data.modelTestData, '');
        const plan = (await call('/plans', 'POST', { projectId: 'p1', name: '查询', content: '### TC-01 查询' })).data; await call('/plans/' + plan.id + '/approve', 'POST', {});
        const manifest = (await call('/plans/' + plan.id + '/manifest')).data;
        const suite = (await call('/modules', 'POST', { planId: plan.id, planVersion: manifest.planVersion, name: '查询', manifestText: 'TC-01 查询', manifestConfirmed: true })).data;
        assert.equal((await call('/suites/' + suite.id + '/approve', 'POST', {})).status, 400);
        const missing = (await call('/suites/' + suite.id + '/missing')).data;
        const request = { baseHash: missing.hash, version: missing.version, caseIds: ['TC-01'], evidenceId: 'ep1', generationInstruction: '先展开查询区，再选在职', autoExplore: true };
        const job = await call('/suites/' + suite.id + '/complete', 'POST', request); assert.equal(job.status, 202);
        const jobId = job.data.id || job.data.jobId; const detail = await call('/jobs/' + jobId); assert.equal(detail.data.generationInstruction, request.generationInstruction);
        assert.equal((await call('/suites/' + suite.id + '/complete', 'POST', { ...request, generationInstruction: 'x'.repeat(10001) })).status, 400);
        const code = "import {test,expect} from '@playwright/test';test('[TC-01] 查询',async({page})=>{await expect(page.getByText('标题')).toBeVisible();});";
        // Attach evidence through the same persisted suite shape used after completion.
        const saved = await call('/suites/' + suite.id, 'PUT', { name: '查询', code }); assert.equal(saved.status, 200); assert.equal(saved.data.validation, null);
        assert.equal((await call('/suites/' + suite.id + '/approve', 'POST', {})).status, 200);
        assert.equal((await call('/runs', 'POST', { suiteId: suite.id })).status, 202);
        await call('/suites/' + suite.id, 'PUT', { name: '查询', code: "test('[TC-01] 查询',()=>{process.exit(0);});" });
        assert.equal((await call('/suites/' + suite.id + '/approve', 'POST', {})).status, 400);
    } finally { child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)); await rm(data, { recursive: true, force: true }); }
});
