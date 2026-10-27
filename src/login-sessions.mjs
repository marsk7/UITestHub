import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export class LoginSessions {
    constructor({ save, launch } = {}) { this.sessions = new Map(); this.save = save; this.launch = launch || (() => chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH, args: JSON.parse(process.env.BROWSER_ARGS_JSON || '[]') } : {}) })); this.timer = setInterval(() => { for (const s of this.sessions.values()) if (Date.now() > s.expires) this.close(s.id).catch(() => { }); }, 15000); this.timer.unref(); }
    async start(owner, project) {
        if (this.sessions.size >= 2) fail('最多同时打开两个登录窗口，请先关闭已有窗口。', 409);
        if ([...this.sessions.values()].some(s => s.project.id === project.id)) fail('此项目已有登录窗口，请先关闭或等待到期。', 409);
        const s = { id: randomUUID(), owner, project, expires: Date.now() + 15 * 60 * 1000, chain: Promise.resolve(), browser: null, context: null, page: null, closed: false }; this.sessions.set(s.id, s);
        try {
            s.browser = await this.launch(); if (s.closed) { await s.browser.close(); fail('登录会话已关闭', 410); } s.context = await s.browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false }); s.context.on('page', p => { s.page = p; p.on('dialog', d => d.dismiss().catch(() => { })); }); s.page = await s.context.newPage();
            const url = new URL(project.entry || '/', project.baseURL); if (url.origin !== new URL(project.baseURL).origin) fail('入口必须属于项目环境');
            await s.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); return { id: s.id, expires: s.expires };
        } catch (e) { await this.close(s.id); throw e; }
    }
    owned(id, owner) { const s = this.sessions.get(id); if (!s || s.closed || Date.now() > s.expires) fail('登录窗口已到期，请重新打开。', 410); if (s.owner !== owner) fail('无权访问此登录窗口', 403); return s; }
    async use(id, owner, fn) { const s = this.owned(id, owner); const next = s.chain.then(() => { this.owned(id, owner); const pages = s.context.pages(); if (!s.page || s.page.isClosed()) s.page = pages.at(-1); if (!s.page) fail('登录页面已关闭，请重新打开。', 410); return fn(s); }); s.chain = next.catch(() => { }); return next; }
    async frame(id, owner) { return this.use(id, owner, async s => ({ image: (await s.page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 })).toString('base64'), url: s.page.url().split(/[?#]/)[0], active: s.context.pages().indexOf(s.page), pages: s.context.pages().map((p, index) => ({ index, url: p.url().split(/[?#]/)[0] })), width: 1280, height: 800, expires: s.expires })); }
    async input(id, owner, b) {
        return this.use(id, owner, async s => {
            const p = s.page, xy = () => { if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || b.x < 0 || b.y < 0 || b.x > 1280 || b.y > 800) fail('无效坐标'); return [b.x, b.y]; };
            if (b.type === 'click') { await p.mouse.click(...xy()); }
            else if (b.type === 'down') { await p.mouse.move(...xy()); await p.mouse.down(); }
            else if (b.type === 'move') { await p.mouse.move(...xy()); }
            else if (b.type === 'up') { await p.mouse.move(...xy()); await p.mouse.up(); }
            else if (b.type === 'text') { if (typeof b.text !== 'string' || b.text.length > 2000) fail('输入过长'); await p.keyboard.insertText(b.text); }
            else if (b.type === 'key') { if (!['Tab', 'Shift+Tab', 'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Control+A', 'Home', 'End', 'Space'].includes(b.key)) fail('不支持的按键'); await p.keyboard.press(b.key); }
            else if (b.type === 'wheel') { if (!Number.isFinite(b.delta)) fail('无效滚动'); await p.mouse.wheel(0, Math.max(-800, Math.min(800, b.delta))); }
            else if (b.type === 'tab') { const tab = s.context.pages()[b.index]; if (!tab) fail('页面已关闭'); s.page = tab; }
            else if (b.type === 'reload') await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            else fail('不支持的操作'); return { ok: true };
        });
    }
    async persist(id, owner, confirmed) {
        if (confirmed !== true) fail('请先确认已进入业务页面'); return this.use(id, owner, async s => {
            if (new URL(s.page.url()).origin !== new URL(s.project.baseURL).origin) fail('请返回项目业务页面后保存，当前仍在其他域名。');
            const storage = await s.context.storageState({ indexedDB: true }); await this.save(s.project, storage); await this.close(id); return { ok: true };
        });
    }
    async close(id) { const s = this.sessions.get(id); if (!s) return; s.closed = true; this.sessions.delete(id); await s.browser?.close().catch(() => { }); }
    async closeOwner(owner) { await Promise.all([...this.sessions.values()].filter(s => s.owner === owner).map(s => this.close(s.id))); }
    async dispose() { clearInterval(this.timer); await Promise.all([...this.sessions.keys()].map(id => this.close(id))); }
}
