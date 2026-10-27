import path from 'node:path';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { codeHash, checkScript } from './script-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This is a trusted-script runner, not a sandbox. Execution is explicitly opted in.
export function verificationSettings(input = {}) {
  if (input.liveValidation === true && input.executionConfirmed !== true) throw Object.assign(new Error('逐用例浏览器验证会执行生成的脚本，请确认目标环境和业务操作范围'), { status: 400 });
  return { liveValidation: input.liveValidation === true, executionConfirmed: input.liveValidation === true && input.executionConfirmed === true };
}
export function validationSummary(rows = []) {
  return { total: rows.length, passed: rows.filter(r => r.status === 'passed').length, failed: rows.filter(r => r.status === 'failed').length, error: rows.filter(r => r.status === 'error').length, blocked: rows.filter(r => r.status === 'blocked').length, notRun: rows.filter(r => r.status === 'not-run').length };
}
export function generationOutcome(result, liveValidation = false) {
  if (!result.coverage.complete) return 'incomplete';
  if (liveValidation && result.generationVerification?.summary.passed !== result.coverage.expected) return 'needs-review';
  return 'succeeded';
}
export function classifyFailure(steps = [], errors = []) {
  const failed = steps.filter(s => s.error), text = [...failed.map(s => s.error), ...errors].join('\n');
  if (/net::|browser.*closed|browser.*launch|ECONN|ENOTFOUND|executable.*exist/i.test(text)) return 'environment';
  // An assertion failure is never reclassified as a locator fix just because it says "not found".
  if (failed.some(s => s.category === 'expect')) return 'assertion';
  if (failed.some(s => s.category === 'pw:api') && /locator|strict mode|element|waiting for|Timeout/i.test(text)) return 'locator';
  return 'unknown';
}
export async function verifyGeneratedCase({ code, target, project, storageState, dir, execute, cancelled = async () => false, progress = async () => { } }) {
  const check = checkScript(code); if (!check.ok) throw new Error(check.errors.join('；'));
  if (await cancelled()) throw new Error('生成验证已取消');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const privateFile = path.join(dir, 'storage.json'), modules = path.join(dir, 'node_modules');
  const config = { testDir: '.', testMatch: 'suite.spec.ts', timeout: 30000, globalTimeout: 60000, workers: 1, retries: 0, forbidOnly: true, outputDir: 'test-results', reporter: [['line'], [path.join(ROOT, 'src/generation-reporter.mjs')], ['html', { outputFolder: 'html-report', open: 'never' }]], use: { baseURL: project.baseURL, browserName: 'chromium', headless: true, actionTimeout: 10000, navigationTimeout: 20000, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...(storageState ? { storageState: 'storage.json' } : {}), ...(process.env.BROWSER_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: JSON.parse(process.env.BROWSER_ARGS_JSON || '[]') } } : {}) } };
  const env = { PATH: process.env.PATH, HOME: dir, CI: '1', FORCE_COLOR: '0', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright') };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) env[k] = process.env[k];
  let outcome, report = {};
  try {
    await symlink(path.join(ROOT, 'node_modules'), modules, 'dir');
    if (storageState) await writeFile(privateFile, JSON.stringify(storageState), { mode: 0o600 });
    // A separate support module keeps generated source and line numbers intact.
    await writeFile(path.join(dir, 'suite.spec.ts'), code + '\n\n' + `test.afterEach(async ({page}, testInfo) => {
    if (testInfo.status !== 'passed' && !page.isClosed()) {
      const snapshot = await page.locator('body').ariaSnapshot({timeout: 2000}).catch(() => '页面快照不可用');
      await testInfo.attach('failure-page', {body: snapshot.slice(0,16000), contentType:'text/plain'});
    }
  });\n`);
    await writeFile(path.join(dir, 'playwright.config.cjs'), 'module.exports = ' + JSON.stringify(config));
    await progress(`${target.id} 浏览器验证开始：逐步记录操作与断言，不自动重跑业务操作。\n`);
    outcome = await execute([process.execPath, path.join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '--config=playwright.config.cjs'], dir, env, 70000);
    if (await cancelled()) throw new Error('生成验证已取消');
    try { report = JSON.parse(await readFile(path.join(dir, 'verification.json'), 'utf8')); } catch { }
  } finally { await rm(privateFile, { force: true }); await rm(modules, { force: true }); }
  const errors = (report.errors || []).map(x => String(x).slice(0, 6000)), steps = report.steps || [];
  const category = classifyFailure(steps, errors);
  const status = outcome.timed || !report.finished || category === 'environment' || outcome.code !== 0 && report.status === 'passed' ? 'error' : outcome.code === 0 && report.status === 'passed' ? 'passed' : report.status === 'failed' || report.status === 'timedOut' ? 'failed' : 'error';
  let snapshot = '';
  for (const attachment of report.attachments || []) { if (attachment.name !== 'failure-page') continue; if (attachment.body) snapshot = attachment.body.slice(0, 16000); }
  const result = { ...target, status, category: status === 'passed' ? null : category, codeHash: codeHash(code), duration: report.duration || 0, steps, errors, snapshot, at: new Date().toISOString(), timedOut: !!outcome.timed };
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
