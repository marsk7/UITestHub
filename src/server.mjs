import { moduleCases } from './module-tree.mjs';
import { caseResults } from './run-results.mjs';
import { canProject, requireProject, requireAdmin, requireExecution, permitRoute, publicAccount } from './access.mjs';
import { initAccounts, authenticate, userById, listUsers, saveUser, changePassword } from './accounts.mjs';
import { verificationSettings } from './generation-verifier.mjs';
import { createReportService, listArtifacts, sendArtifact } from './report-service.mjs';
import { missingCases, retryTargets } from './suite-workflow.mjs';
import { planManifest, confirmManifest, assertionPolicy, coverageOf } from './generation.mjs';
import { jobDisplay } from './job-display.mjs';
import { cases, replaceCase, selectCase } from './case-scripts.mjs';
import { codeHash, checkEvidence, checkScript } from './script-check.mjs';
import { LoginSessions } from './login-sessions.mjs';
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DATA, query, init, replaceRecord, recycleRecord, suitePlan, list, get, put, jobs, job as getJob, enqueue as queueJob, now } from './db.mjs';
import { seed } from './seed.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = process.env.ADMIN_PASSWORD;
if (!secret || secret.length < 6) throw new Error('ADMIN_PASSWORD must contain at least 6 characters. Use scripts/setup.mjs.');
const sessions = new Map(), attempts = new Map();
const reports = createReportService({ data: DATA, ownerActive: async (owner, jobId) => { const actor = await sessionUser(owner); if (!actor) return false; const j = await getJob(jobId); return !!j && canProject(actor, j.payload.projectId); } });
const loginSessions = new LoginSessions({
    save: async (project, storage) => {
        const current = await get(project.id, 'project'); if (!current || current.baseURL !== project.baseURL) throw Object.assign(new Error('项目环境已修改，请重新登录'), { status: 409 });
        const dir = path.join(DATA, 'auth'); await mkdir(dir, { recursive: true, mode: 0o700 }); const tmp = path.join(dir, project.id + '.' + randomBytes(8).toString('hex') + '.tmp');
        try { await writeFile(tmp, JSON.stringify(storage), { mode: 0o600 }); await rename(tmp, path.join(dir, project.id + '.json')); } finally { await rm(tmp, { force: true }); }
        await put('project', { ...current, auth: true, authSavedAt: new Date().toISOString() }, current.id);
    }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await loginSessions.dispose(); process.exit(0); });

async function sessionUser(token) { const s = sessions.get(token); if (!s || s.expiresAt <= Date.now()) { sessions.delete(token); return null; } const user = await userById(s.userId); if (!user?.enabled || user.sessionVersion !== s.version) { sessions.delete(token); await loginSessions.closeOwner(token); return null; } return { ...user, ownedProjectIds: (await list('project')).filter(p => p.ownerId === user.id).map(p => p.id) }; }
async function revokeSessions(userId) { for (const [token, s] of sessions) if (s.userId === userId) { sessions.delete(token); await loginSessions.closeOwner(token); } }
await init();
await initAccounts(secret);
await seed();
const accepted = j => ({ id: j.id, status: j.status, kind: j.kind });
function send(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function err(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function required(value, label, max = 20000) { if (typeof value !== 'string' || !value.trim() || value.length > max) err(`${label}不能为空，且长度不能超过 ${max}`); return value.trim(); }
function optionalInstruction(value) { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > 10000) err('补充生成指令不能超过 10000 字符'); return value.trim(); }
function explorationSettings(b) { return { ...verificationSettings(b), generationInstruction: optionalInstruction(b.generationInstruction), locatorNotes: String(b.locatorNotes || '').slice(0, 10000), explorationSteps: Math.max(1, Math.min(8, Math.trunc(Number(b.explorationSteps) || 6))), explorationRounds: Math.max(1, Math.min(3, Math.trunc(Number(b.explorationRounds) || 2))) }; }
function projectInput(b) { const baseURL = required(b.baseURL, '环境地址', 2000); let u; try { u = new URL(baseURL); } catch { err('环境地址格式不正确'); } if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) err('仅支持不含凭证的 HTTP/HTTPS 地址'); if (!String(b.entry || '/').startsWith('/') || String(b.entry).startsWith('//')) err('入口路径必须以单个 / 开头'); return { name: required(b.name, '项目名称', 100), baseURL: u.origin, entry: String(b.entry || '/'), description: String(b.description || '').slice(0, 5000) }; }
async function body(req) { if (req.parsedBody !== undefined) return req.parsedBody; let s = ''; for await (const chunk of req) { s += chunk; if (Buffer.byteLength(s) > 2_000_000) err('请求内容超过 2MB', 413); } try { return req.parsedBody = JSON.parse(s || '{}'); } catch { err('JSON 格式错误'); } }
const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    try {
        const u = new URL(req.url, 'http://localhost'), p = u.pathname, m = req.method;
        if (p.startsWith('/report-assets/')) { if (await reports.handle(req, res, u)) return; err('报告资源不存在', 404); }
        if (p === '/health') { await query('SELECT 1'); return send(res, 200, { ok: true }); }
        if (['/api/login', '/api/register'].includes(p) && m === 'POST') {
            const ip = p + ':' + req.socket.remoteAddress, t = Date.now(), a = attempts.get(ip) || { start: t, count: 0 }; if (t - a.start > 900000) { a.start = t; a.count = 0; } a.count++; attempts.set(ip, a); if (a.count > 20) err('登录尝试过多，请15分钟后重试', 429);
            const b = await body(req);
            if (p === '/api/register') { const user = await saveUser({ username: b.username, displayName: b.displayName, password: b.password, role: 'tester', enabled: true, projectIds: [] }); return send(res, 201, { ok: true, username: user.username }); }
            const user = await authenticate(b.username, b.password);
            const token = randomBytes(32).toString('hex'); sessions.set(token, { userId: user.id, version: user.sessionVersion, expiresAt: t + 8 * 3600000 }); for (const [k, v] of sessions) if (v.expiresAt < t) sessions.delete(k);
            res.setHeader('Set-Cookie', `testhub=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`); return send(res, 200, { ok: true });
        }
        if (p.startsWith('/api/')) {
            const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('testhub='))?.slice(8);
            const actor = await sessionUser(cookie); if (!actor) err('请先登录', 401);
            if (!['GET', 'HEAD'].includes(m) && req.headers.origin) { let originHost; try { originHost = new URL(req.headers.origin).host; } catch { err('跨站请求被拒绝', 403); } if (originHost !== req.headers.host) err('跨站请求被拒绝', 403); }
            let routeProjectId;
            if (!['GET', 'HEAD'].includes(m)) {
                const scoped = p.match(/^\/api\/(projects|plans|suites|evidence|jobs|login-sessions)\/([\w-]+)/);
                if (scoped) { const [, kind, id] = scoped; if (kind === 'projects') routeProjectId = id; else if (kind === 'jobs') routeProjectId = (await getJob(id))?.payload.projectId; else if (kind === 'login-sessions') routeProjectId = loginSessions.owned(id, cookie).project.id; else routeProjectId = (await get(id, { plans: 'plan', suites: 'suite', evidence: 'evidence' }[kind]))?.projectId; }
                else if (['/api/validate', '/api/runs', '/api/generator', '/api/planner', '/api/explore', '/api/plans', '/api/suites', '/api/modules'].includes(p)) { const b = await body(req); routeProjectId = ['/api/validate', '/api/runs'].includes(p) ? (await get(b.suiteId, 'suite'))?.projectId : ['/api/generator', '/api/modules'].includes(p) ? (await get(b.planId, 'plan'))?.projectId : b.projectId; }
            }
            permitRoute(actor, m, p, routeProjectId);
            const must = async (id, kind, includeDeleted = false) => { const record = await get(id, kind); if (!record || record.deletedAt && !includeDeleted) err('记录不存在或已删除', 404); requireProject(actor, kind === 'project' ? record.id : record.projectId); return record; };
            const job = async id => { const j = await getJob(id); if (!j) err('任务不存在', 404); requireProject(actor, j.payload.projectId); return j; };
            const enqueue = async (kind, payload) => { requireProject(actor, payload.projectId); if (payload.liveValidation) requireExecution(actor, payload.projectId); let module = payload.suite || payload.plan; if (!module && payload.suiteId) module = await get(payload.suiteId, 'suite'); return queueJob(kind, { ...payload, moduleId: payload.moduleId || module?.planId || module?.id || null, moduleName: payload.moduleName || module?.moduleName || module?.name || null, requestedBy: actor.id }); };
            if (p === '/api/users' && m === 'GET') { requireAdmin(actor); return send(res, 200, await listUsers()); }
            if ((p === '/api/users' && m === 'POST') || (/^\/api\/users\/[\w-]+$/.test(p) && m === 'PATCH')) {
                requireAdmin(actor); const b = await body(req); for (const projectId of b.projectIds || []) await must(projectId, 'project');
                const user = await saveUser(b, { id: m === 'PATCH' ? p.split('/').at(-1) : undefined, version: b.version, actorId: actor.id }); await revokeSessions(user.id); return send(res, m === 'POST' ? 201 : 200, user);
            }
            if (p === '/api/me/password' && m === 'POST') { const b = await body(req); await changePassword(actor, b.oldPassword, b.password); await revokeSessions(actor.id); return send(res, 200, { ok: true, relogin: true }); }
            if (p === '/api/logout' && m === 'POST') { await loginSessions.closeOwner(cookie); sessions.delete(cookie); res.setHeader('Set-Cookie', 'testhub=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, { ok: true }); }
            if (p === '/api/state' && m === 'GET') {
                const projects = (await list('project')).filter(x => canProject(actor, x.id)), visible = x => canProject(actor, x.projectId);
                const plans = (await list('plan')).filter(visible), suites = (await list('suite')).filter(visible);
                return send(res, 200, { me: publicAccount(actor), projects, plans: plans.filter(x => !x.deletedAt), suites: suites.filter(x => !x.deletedAt).map(s => ({ ...s, caseInventory: moduleCases(s) })), trash: { plans: plans.filter(x => x.deletedAt), suites: suites.filter(x => x.deletedAt) }, evidence: (await list('evidence')).filter(visible).map(({ controls, tables, frames, ...e }) => e), jobs: (await jobs(actor.role === 'admin' ? undefined : [...new Set([...actor.projectIds, ...actor.ownedProjectIds])])).filter(x => visible(x.payload)).map(({ payload, log, ...j }) => ({ ...j, ...jobDisplay(j.kind, payload) })), workers: await query('SELECT * FROM workers'), model: { configured: !!process.env.LLM_BASE_URL && !!process.env.LLM_MODEL, model: process.env.LLM_MODEL || '', baseURL: actor.role === 'admin' ? process.env.LLM_BASE_URL || '' : '' } });
            }
            if (p === '/api/projects' && m === 'POST') return send(res, 201, await put('project', { ...projectInput(await body(req)), auth: false, ownerId: actor.id }));
            let match;
            if ((match = p.match(/^\/api\/(plans|suites)\/([\w-]+)(?:\/(restore))?$/)) && ((m === 'DELETE' && !match[3]) || (m === 'POST' && match[3] === 'restore'))) { await must(match[2], match[1] === 'plans' ? 'plan' : 'suite', true); return send(res, 200, await recycleRecord(match[2], match[1] === 'plans' ? 'plan' : 'suite', m === 'POST')); }
            if ((match = p.match(/^\/api\/(plans|suites)\/([\w-]+)\/metadata$/)) && m === 'PATCH') {
                const kind = match[1] === 'plans' ? 'plan' : 'suite', old = await must(match[2], kind), b = await body(req); if (b.version !== old.updated) err('记录已变化，请刷新', 409);
                return send(res, 200, await replaceRecord(old.id, old.updated, { ...old, name: required(b.name, '名称', 100), moduleName: required(b.moduleName, '功能模块', 100), purpose: required(b.purpose, '用途 / 版本说明', 300) }));
            }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)\/missing$/)) && m === 'GET') {
                const suite = await must(match[1], 'suite'); return send(res, 200, { missing: missingCases(suite), hash: codeHash(suite.code), version: suite.updated, gaps: suite.gaps || [], blockers: suite.blockers || [] });
            }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)\/(complete|explore-gaps)$/)) && m === 'POST') {
                const suite = await must(match[1], 'suite'), b = await body(req); if (b.baseHash !== codeHash(suite.code) || b.version !== suite.updated) err('脚本已变化，请刷新', 409);
                const targets = retryTargets(suite, b.caseIds), pr = await must(suite.projectId, 'project'), plan = await suitePlan(suite);
                const evidence = await must(b.evidenceId || suite.evidenceId, 'evidence'); checkEvidence(evidence, pr);
                const safeEvidence = evidence; let storageState = null; if (pr.auth) storageState = JSON.parse(await readFile(path.join(DATA, 'auth', pr.id + '.json'), 'utf8'));
                const kind = match[2] === 'complete' ? 'complete-suite' : 'explore-gaps';
                return send(res, 202, accepted(await enqueue(kind, { projectId: pr.id, name: suite.name, suiteId: suite.id, suite, plan, project: pr, evidence: safeEvidence, manifest: targets, assertionPolicy: suite.assertionPolicy, autoExplore: b.autoExplore === true, ...explorationSettings(b), storageState })));
            }

            if ((match = p.match(/^\/api\/projects\/([\w-]+)\/login-session$/)) && m === 'POST') return send(res, 201, await loginSessions.start(cookie, await must(match[1], 'project')));
            if ((match = p.match(/^\/api\/login-sessions\/([\w-]+)(?:\/(frame|input|save))?$/))) {
                const id = match[1], op = match[2]; const loginSession = loginSessions.owned(id, cookie); requireProject(actor, loginSession.project.id);
                if (m === 'GET' && op === 'frame') return send(res, 200, await loginSessions.frame(id, cookie));
                if (m === 'POST' && op === 'input') return send(res, 200, await loginSessions.input(id, cookie, await body(req)));
                if (m === 'POST' && op === 'save') return send(res, 200, await loginSessions.persist(id, cookie, (await body(req)).confirmed));
                if (m === 'DELETE' && !op) { await loginSessions.close(id); return send(res, 200, { ok: true }); }
                err('请求方法不支持', 405);
            }

            if ((match = p.match(/^\/api\/projects\/([\w-]+)$/)) && m === 'PUT') { const old = await must(match[1], 'project'), input = projectInput(await body(req)); return send(res, 200, await put('project', { ...old, ...input, ...(input.baseURL !== old.baseURL ? { auth: false, authSavedAt: null } : {}) }, old.id)); }
            if (p === '/api/explore' && m === 'POST') {
                const b = await body(req), pr = await must(b.projectId, 'project'); let storageState = null;
                if (pr.auth) storageState = JSON.parse(await readFile(path.join(DATA, 'auth', pr.id + '.json'), 'utf8'));
                return send(res, 202, accepted(await enqueue('explore', { projectId: pr.id, name: pr.name + ' · 页面采集', project: pr, storageState, expand: b.expand !== false })));
            }
            if ((match = p.match(/^\/api\/evidence\/([\w-]+)$/)) && m === 'GET') return send(res, 200, await must(match[1], 'evidence'));
            if ((match = p.match(/^\/api\/evidence\/([\w-]+)\/confirm$/)) && m === 'POST') {
                const old = await must(match[1], 'evidence'), b = await body(req), pr = await must(old.projectId, 'project'); checkEvidence(old, pr, false);
                return send(res, 200, await put('evidence', { ...old, rules: String(b.rules || '').trim().slice(0, 20000), selectedData: String(b.selectedData || '').trim().slice(0, 20000), modelTestData: String(b.selectedData || '').trim().slice(0, 20000), notes: String(b.notes || '').slice(0, 10000), confirmed: true, confirmedAt: now() }, old.id));
            }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)\/cases$/)) && m === 'GET') {
                const suite = await must(match[1], 'suite'); return send(res, 200, { suiteId: suite.id, hash: codeHash(suite.code), cases: suite.manifest && moduleCases(suite).every(c => c.status === 'missing') ? [] : cases(suite.code), inventory: moduleCases(suite) });
            }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)\/cases\/(\d+)$/)) && m === 'PUT') {
                const suite = await must(match[1], 'suite'), b = await body(req); if (b.baseHash !== codeHash(suite.code)) err('脚本已修改，请重新打开用例', 409);
                const patch = replaceCase(suite.code, match[2], required(b.code, '单用例脚本', 100000));
                const { code: combined, ...change } = patch; const history = [...(suite.caseHistory || []), { ...change, at: now(), source: 'manual-or-reviewed-ai' }].slice(-20);
                return send(res, 200, await replaceRecord(suite.id, suite.updated, { ...suite, code: patch.code, generationVerification: null, revision: (suite.revision || 1) + 1, ...(suite.manifest ? { coverage: coverageOf(patch.code, suite.manifest) } : {}), caseHistory: history, approved: false, validation: null, caseValidations: {} }));
            }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)\/cases\/(\d+)\/regenerate$/)) && m === 'POST') {
                const suite = await must(match[1], 'suite'), b = await body(req); if (b.baseHash !== codeHash(suite.code)) err('脚本已修改，请刷新', 409);
                const target = cases(suite.code).find(c => c.id === match[2]); if (!target) err('用例不存在', 404);
                let evidence = null; if (suite.evidenceId) { evidence = await must(suite.evidenceId, 'evidence'); checkEvidence(evidence, await must(suite.projectId, 'project')); evidence = { ...evidence }; }
                const verification = (suite.generationVerification?.rows || []).find(r => target.title === `[${r.id}] ${r.title}`);
                if (verification?.diagnosticEvidenceId) { const diagnostic = await must(verification.diagnosticEvidenceId, 'evidence'); checkEvidence(diagnostic, await must(suite.projectId, 'project')); evidence = diagnostic; }
                return send(res, 202, accepted(await enqueue('regenerate-case', { projectId: suite.projectId, name: suite.name + ' · ' + target.title, suiteId: suite.id, baseHash: codeHash(suite.code), suiteCode: suite.code, assertionPolicy: suite.assertionPolicy, target, runtimeFeedback: verification ? { category: verification.category, errors: verification.errors, steps: verification.steps, snapshot: verification.snapshot, recommendations: verification.recommendations } : null, instruction: required(b.instruction, '修改要求', 20000), evidence })));
            }
            if ((match = p.match(/^\/api\/plans\/([\w-]+)\/manifest$/)) && m === 'GET') { const plan = await must(match[1], 'plan'); return send(res, 200, { manifest: planManifest(plan.content), planVersion: plan.updated }); }
            if (p === '/api/plans' && m === 'POST') { const b = await body(req); await must(b.projectId, 'project'); return send(res, 201, await put('plan', { projectId: b.projectId, name: required(b.name, '计划名称', 100), requirement: String(b.requirement || ''), content: required(b.content, '用例内容', 100000), approved: false })); }
            if ((match = p.match(/^\/api\/plans\/([\w-]+)$/)) && m === 'PUT') { const old = await must(match[1], 'plan'), b = await body(req); if (b.version !== undefined && b.version !== old.updated) err('计划已被其他操作修改，请刷新后重试', 409); return send(res, 200, await replaceRecord(old.id, old.updated, { ...old, name: required(b.name, '计划名称', 100), content: required(b.content, '用例内容', 100000), approved: false })); }
            if (p === '/api/suites' && m === 'POST') { const b = await body(req); await must(b.projectId, 'project'); return send(res, 201, await put('suite', { projectId: b.projectId, name: required(b.name, '脚本名称', 100), code: required(b.code, '脚本', 200000), approved: false })); }
            if ((match = p.match(/^\/api\/suites\/([\w-]+)$/)) && m === 'PUT') { const old = await must(match[1], 'suite'), b = await body(req); return send(res, 200, await replaceRecord(old.id, old.updated, { ...old, name: required(b.name, '脚本名称', 100), code: required(b.code, '脚本', 200000), generationVerification: null, revision: (old.revision || 1) + 1, approved: false, validation: null, caseValidations: {}, gaps: [], ...(old.manifest ? { coverage: coverageOf(b.code, old.manifest) } : {}) })); }
            if ((match = p.match(/^\/api\/(plans|suites)\/([\w-]+)\/approve$/)) && m === 'POST') { const kind = match[1] === 'plans' ? 'plan' : 'suite', old = await must(match[2], kind); if (kind === 'suite') { const check = checkScript(old.code); if (!check.ok) err('静态检查未通过：' + check.errors.join('；')); } if (kind === 'suite' && old.manifest && !coverageOf(old.code, old.manifest).complete) err('用例覆盖不完整或存在重复，请补全计划中全部用例'); if (kind === 'suite' && old.evidenceId) { if (old.gaps?.length) err('脚本仍有未解决的缺口，请编辑修正'); const e = await must(old.evidenceId, 'evidence'); checkEvidence(e, await must(old.projectId, 'project')); if (e.updated !== old.evidenceVersion) err('页面依据已修改，请重新生成脚本'); } return send(res, 200, await replaceRecord(old.id, old.updated, { ...old, approved: true, approvedAt: now() })); }
            if (p === '/api/planner' && m === 'POST') { const b = await body(req), pr = await must(b.projectId, 'project'); return send(res, 202, await enqueue('planner', { projectId: pr.id, name: required(b.name, '计划名称', 100), requirement: required(b.requirement, '需求', 80000), project: pr })); }
            if (p === '/api/modules' && m === 'POST') {
                const b = await body(req), plan = await must(b.planId, 'plan'); if (!plan.approved) err('请先审核测试计划'); if (b.planVersion !== plan.updated) err('计划已变化，请重新核对', 409);
                const manifest = confirmManifest(b.manifestText, plan.content, b.manifestConfirmed), name = required(b.name || plan.name, '模块名称', 100);
                const code = "import {test,expect} from '@playwright/test';\n";
                return send(res, 201, await put('suite', { projectId: plan.projectId, planId: plan.id, planSnapshot: plan, name, moduleName: name, purpose: '模块用例管理', revision: 1, manifest, code, coverage: coverageOf(code, manifest), approved: false, validation: null, gaps: [], assertionPolicy: assertionPolicy(b.assertionPolicy) }));
            }
            if (p === '/api/generator' && m === 'POST') {
                const b = await body(req), plan = await must(b.planId, 'plan'); if (!plan.approved) err('请先审核测试计划'); const pr = await must(plan.projectId, 'project');
                const evidence = await must(b.evidenceId, 'evidence'); checkEvidence(evidence, pr);
                if (b.planVersion !== plan.updated) err('计划已变化，请重新打开生成窗口', 409);
                const manifest = confirmManifest(b.manifestText, plan.content, b.manifestConfirmed), policy = assertionPolicy(b.assertionPolicy);
                const safeEvidence = evidence;
                let storageState = null; if ((b.autoExplore === true || b.liveValidation === true) && pr.auth) storageState = JSON.parse(await readFile(path.join(DATA, 'auth', pr.id + '.json'), 'utf8'));
                return send(res, 202, accepted(await enqueue('generator', { projectId: plan.projectId, name: String(b.suiteName || plan.name).slice(0, 100), moduleName: plan.moduleName || plan.name, purpose: String(b.purpose || '全量生成').slice(0, 300), plan, project: pr, evidence: safeEvidence, manifest, assertionPolicy: policy, autoExplore: b.autoExplore === true, ...explorationSettings(b), storageState })));
            }
            if (p === '/api/validate' && m === 'POST') {
                const b = await body(req); if (b.confirmed !== true) err('请确认已检查脚本和试运行范围'); const suite = await must(b.suiteId, 'suite'); if (b.caseId !== undefined && b.baseHash !== codeHash(suite.code)) err('脚本已变化，请重新选择用例', 409); const pr = await must(suite.projectId, 'project');
                if (suite.evidenceId) { const e = await must(suite.evidenceId, 'evidence'); checkEvidence(e, pr); if (e.updated !== suite.evidenceVersion) err('页面依据已修改，请重新生成脚本'); }
                await replaceRecord(suite.id, suite.updated, { ...suite, validation: null, approved: false });
                let storageState = null; if (pr.auth) storageState = JSON.parse(await readFile(path.join(DATA, 'auth', pr.id + '.json'), 'utf8'));
                return send(res, 202, accepted(await enqueue('validate', { projectId: pr.id, name: suite.name + ' · 试运行', project: pr, suite, storageState, codeHash: codeHash(suite.code), ...(b.caseId !== undefined ? { caseId: String(b.caseId), selectedCode: selectCase(suite.code, String(b.caseId)) } : {}) })));
            }
            if (p === '/api/runs' && m === 'POST') {
                const b = await body(req), suite = await must(b.suiteId, 'suite'); if (!suite.approved) err('请先审核脚本，修改后需重新审核'); const pr = await must(suite.projectId, 'project'); if (suite.evidenceId) { const e = await must(suite.evidenceId, 'evidence'); checkEvidence(e, pr); if (e.updated !== suite.evidenceVersion) err('页面依据已修改，请重新生成脚本'); } let storageState = null; if (pr.auth) storageState = JSON.parse(await readFile(path.join(DATA, 'auth', pr.id + '.json'), 'utf8'));
                if (b.caseId !== undefined && b.baseHash !== codeHash(suite.code)) err('脚本已变化，请重新选择用例', 409); const j = await enqueue('run', { projectId: pr.id, name: suite.name, project: pr, suite, storageState, ...(b.caseId !== undefined ? { caseId: String(b.caseId), selectedCode: selectCase(suite.code, String(b.caseId)) } : {}) }); return send(res, 202, { id: j.id, status: j.status });
            }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)$/)) && m === 'GET') { const j = await job(match[1]); if (!j) err('任务不存在', 404); const { payload, ...safe } = j; if (payload.generationInstruction) safe.generationInstruction = payload.generationInstruction; if (['generator', 'complete-suite'].includes(j.kind) && !safe.result) { try { safe.result = { generationVerification: JSON.parse(await readFile(path.join(DATA, 'runs', j.id, 'generation-progress.json'), 'utf8')) }; } catch { } } if (['run', 'validate'].includes(j.kind) && !safe.result?.cases) { try { const reportFile = path.join(DATA, 'runs', j.id, 'results.json'); if ((await stat(reportFile)).size <= 10_000_000) safe.result = { ...safe.result, cases: caseResults(JSON.parse(await readFile(reportFile, 'utf8'))) }; } catch { } } return send(res, 200, { ...safe, ...jobDisplay(j.kind, payload) }); }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/)) && m === 'POST') { await job(match[1]); await query("UPDATE jobs SET payload=JSON_REMOVE(payload,'$.storageState'),cancel=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated=? WHERE id=? AND status IN ('queued','running')", [now(), match[1]]); return send(res, 200, { ok: true }); }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)\/analyze$/)) && m === 'POST') { const j = await job(match[1]); if (!j || !['run', 'validate'].includes(j.kind) || !['passed', 'failed', 'error', 'interrupted'].includes(j.status)) err('该执行结果暂不可分析'); return send(res, 202, await enqueue('reporter', { projectId: j.payload.projectId, name: j.payload.name, runId: j.id, moduleId: j.payload.moduleId, moduleName: j.payload.moduleName, summary: j.result, log: j.log })); }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)\/report-link$/)) && m === 'POST') { if (!(await job(match[1]))) err('任务不存在', 404); return send(res, 200, await reports.issue(match[1], cookie, (await body(req)).reportPath || 'html-report')); }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)\/artifacts$/)) && m === 'GET') { if (!(await job(match[1]))) err('任务不存在', 404); return send(res, 200, await listArtifacts(path.join(DATA, 'runs', match[1]))); }
            if ((match = p.match(/^\/api\/jobs\/([\w-]+)\/(download|preview)$/)) && ['GET', 'HEAD'].includes(m)) { if (!(await job(match[1]))) err('任务不存在', 404); return await sendArtifact(req, res, path.join(DATA, 'runs', match[1]), u.searchParams.get('file') || '', { inline: match[2] === 'preview' }); }
            err('接口不存在', 404);
        }
        if (m !== 'GET') err('请求方法不支持', 405);
        const allowed = { '/report': 'report.html', '/report.js': 'report.js', '/': 'index.html', '/login-browser': 'login-browser.html', '/login-browser.js': 'login-browser.js', '/app.js': 'app.js', '/style.css': 'style.css', '/demo': 'demo.html', '/favicon.svg': 'favicon.svg' };
        if (!allowed[p]) err('页面不存在', 404);
        const file = allowed[p]; res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' }); res.end(await readFile(path.join(ROOT, 'public', file)));
    } catch (e) { if (res.headersSent) { res.destroy(); return; } send(res, e.status || 500, { error: e.status ? e.message : '服务器处理失败，请查看服务器日志' }); if (!e.status) console.error(e.message); }
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('TestHub listening on ' + (process.env.PORT || 8080)));
