import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, replaceCase, selectCase } from '../src/case-scripts.mjs';
const source = `import {test,expect} from '@playwright/test';
const helper=()=>42;
test.beforeEach(async()=>{});
test.describe('组',()=>{
 test('TC01',async()=>{expect(helper()).toBe(42);});
 test('TC02',async()=>{expect('a').toBe('a');});
});`;
test('single case replacement preserves all other bytes, imports, hooks and names', () => {
    const items = cases(source); assert.equal(items.length, 2); assert.deepEqual(items[1].scope, ['组']);
    const replacement = "test('TC02',async()=>{expect('b').toBe('b');});"; const patch = replaceCase(source, '1', replacement);
    assert.equal(patch.code.slice(0, items[1].start), source.slice(0, items[1].start)); assert.equal(patch.code.slice(items[1].start + replacement.length), source.slice(items[1].end)); assert.equal(cases(patch.code)[0].code, items[0].code);
    assert.throws(() => replaceCase(source, '1', "test('changed',()=>{});")); assert.throws(() => replaceCase(source, '1', "const x=1;" + replacement)); assert.throws(() => replaceCase(source, '1', replacement + "test('extra',()=>{});"));
});
test('single selection preserves hooks and line numbers, rejects dynamic declarations', () => {
    const selected = selectCase(source, '1'); assert.equal(cases(selected).length, 1); assert.equal(cases(selected)[0].title, 'TC02'); assert.equal(selected.split('\n').length, source.split('\n').length); assert.ok(selected.includes('test.beforeEach')); assert.throws(() => cases("for(const n of [1,2]){test('a'+n,()=>{});}")); assert.throws(() => cases("test.skip('a',()=>{});"));
});

test('Playwright executes only selected test and retains shared beforeEach', { timeout: 30000 }, async () => {
    const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises'); const path = await import('node:path'); const os = await import('node:os'); const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'case-run-'));
    try {
        await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'dir'); const code = `import {test,expect} from '@playwright/test'; let marker=0; test.beforeEach(()=>{marker=42;});test('must not run',()=>{throw Error('other executed');});test('selected',()=>{expect(marker).toBe(42);});`;
        await writeFile(path.join(dir, 'selected.spec.ts'), selectCase(code, '1')); await writeFile(path.join(dir, 'playwright.config.cjs'), "module.exports={testDir:'.',testMatch:'selected.spec.ts',workers:1,reporter:'json'}");
        const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('node_modules/@playwright/test/cli.js'), 'test', '--config=' + path.join(dir, 'playwright.config.cjs')], { cwd: dir, timeout: 20000 }); const result = JSON.parse(stdout); assert.equal(result.stats.expected, 1); assert.equal(result.stats.unexpected, 0); assert.equal(result.stats.skipped, 0);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
