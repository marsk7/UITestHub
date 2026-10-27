import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { artifactPath, createReportService, sendArtifact, listArtifacts } from '../src/report-service.mjs';
const root = path.resolve('.');
async function command(args, cwd) { return await new Promise((resolve, reject) => { const child = spawn(process.execPath, args, { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.on('error', reject); child.on('close', code => resolve({ code, output })); }); }
test('online native Playwright report, attachments, ranges and access isolation', { timeout: 60000 }, async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'testhub-report-')), dir = path.join(data, 'runs', 'job'); await mkdir(dir, { recursive: true }); let active = true;
    const service = createReportService({ data, ownerActive: o => active && o === 'owner' });
    const short = createReportService({ data, ownerActive: () => true, ttl: -1 });
    await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    await writeFile(path.join(dir, 'report.spec.ts'), `import {test,expect} from '@playwright/test';test('report failure fixture',async({},info)=>{await info.attach('screen',{body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhUAAAAASUVORK5CYII=','base64'),contentType:'image/png'});await info.attach('note',{body:Buffer.from('attachment hello'),contentType:'text/plain'});expect(1).toBe(2);});`);
    await writeFile(path.join(dir, 'playwright.config.cjs'), `module.exports={testDir:'.',testMatch:'report.spec.ts',reporter:[['html',{outputFolder:'html-report',open:'never'}]],workers:1};`);
    const run = await command([path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.cjs'], dir); assert.equal(run.code, 1, run.output); await rm(path.join(dir, 'node_modules'));
    await writeFile(path.join(dir, 'storage.json'), 'PRIVATE'); await writeFile(path.join(dir, 'sample.webm'), Buffer.from('0123456789')); await writeFile(path.join(dir, 'summary.json'), ' {"failed":1}'); await symlink(path.join(dir, 'storage.json'), path.join(dir, 'leak.txt'));
    const server = http.createServer(async (req, res) => {
        try {
            const u = new URL(req.url, 'http://' + req.headers.host); res.setHeader('X-Frame-Options', 'DENY'); if (await service.handle(req, res, u)) return;
            if (u.pathname.startsWith('/api/')) {
                if (req.headers.cookie !== 'session=ok') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"请先登录"}'); }
                if (u.pathname.endsWith('/report-link')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(await service.issue('job', 'owner'))); }
                return await sendArtifact(req, res, dir, u.searchParams.get('file'), { inline: true });
            }
            const file = { '/report': 'report.html', '/report.js': 'report.js', '/style.css': 'style.css' }[u.pathname]; if (!file) { res.statusCode = 404; return res.end(); } res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(await readFile(path.join(root, 'public', file)));
        } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } else res.destroy(); }
    }); await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        assert.equal((await fetch(base + '/api/jobs/job/report-link', { method: 'POST' })).status, 401);
        await cp(path.join(dir, 'html-report'), path.join(dir, 'verify-TC-01', 'html-report'), { recursive: true });
        const nested = await service.issue('job', 'owner', 'verify-TC-01/html-report'); assert.equal((await fetch(base + nested.url)).status, 200);
        await assert.rejects(service.issue('job', 'owner', '../html-report'), /不允许/);
        const link = await service.issue('job', 'owner'), r = await fetch(base + link.url); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /sandbox allow-scripts/); assert.ok(!r.headers.get('content-security-policy').includes('allow-same-origin'));
        assert.equal((await fetch(base + link.url.replace('index.html', 'storage.json'))).status, 404);
        await assert.rejects(artifactPath(dir, '../storage.json')); await assert.rejects(artifactPath(dir, 'leak.txt')); await assert.rejects(artifactPath(dir, 'storage.json'));
        assert.ok(!(await listArtifacts(dir)).some(f => f.name === 'storage.json' || f.name === 'leak.txt'));
        const media = await fetch(base + '/api/jobs/job/preview?file=sample.webm', { headers: { Cookie: 'session=ok', Range: 'bytes=2-5' } }); assert.equal(media.status, 206); assert.equal(media.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await media.text(), '2345');
        assert.equal((await fetch(base + '/api/jobs/job/preview?file=sample.webm', { headers: { Cookie: 'session=ok', Range: 'bytes=99-100' } })).status, 416);
        const expired = await short.issue('job', 'owner'); const fakeRes = {}; await assert.rejects(short.handle({ method: 'GET', headers: { host: 'localhost' } }, fakeRes, new URL(expired.url, 'http://localhost')), /过期/);
        browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: ['--no-zygote', '--disable-gpu'] } : {}) }); const context = await browser.newContext(); await context.addCookies([{ name: 'session', value: 'ok', url: base }]); const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(base + '/report?job=job'); const report = page.frameLocator('#report-frame'); await report.getByText('report failure fixture', { exact: true }).click({ timeout: 7000 }).catch(async e => { throw new Error(e.message + '\nPAGE ERRORS: ' + JSON.stringify(errors) + '\nFRAMES: ' + JSON.stringify(await Promise.all(page.frames().map(async f => ({ url: f.url(), text: await f.locator('body').innerText().catch(() => '') }))))); }); await report.getByText('Expected: 2', { exact: false }).waitFor({ timeout: 15000 });
        await page.frames().find(f => f.url().includes('/report-assets/')).waitForFunction(() => [...document.images].some(i => i.complete && i.naturalWidth > 0 && i.src.includes('/data/')), null, { timeout: 5000 }); assert.equal(await page.frames()[1].evaluate(() => { try { return !!parent.document.body; } catch { return false; } }), false);
        assert.deepEqual(errors, []);
        active = false; assert.equal((await fetch(base + link.url)).status, 401);
    } finally { await browser?.close(); await new Promise(r => server.close(r)); await rm(data, { recursive: true, force: true }); }
});
