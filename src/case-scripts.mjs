import ts from 'typescript';
import { codeHash, checkScript } from './script-check.mjs';
const fail = m => { throw Object.assign(new Error(m), { status: 409 }); };
export function cases(code) {
    const ast = ts.createSourceFile('suite.spec.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); if (ast.parseDiagnostics.length) fail('整份脚本存在语法错误，请先在整份编辑器修复');
    const items = []; let unsupported = false;
    function walk(n, scope = []) {
        if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
            const call = n.expression, x = call.expression.getText(ast), title = call.arguments[0], fn = call.arguments.at(-1);
            if (x === 'test.describe' && title && ts.isStringLiteralLike(title) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) { for (const s of fn.body.statements) walk(s, [...scope, title.text]); return; }
            if (x === 'test' && title && ts.isStringLiteralLike(title) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
                const index = items.length, start = n.getStart(ast), end = n.end; items.push({ id: String(index), title: title.text, scope, start, end, code: code.slice(start, end), line: ast.getLineAndCharacterOfPosition(start).line + 1 }); return;
            }
        }
        // Only explicit declarations at source/describe scope are editable. Reject dynamic registration.
        if (ts.isSourceFile(n)) { for (const s of n.statements) walk(s, scope); return; }
        function detect(x) { if (ts.isCallExpression(x) && /^test(?:\.(?:skip|only|fixme|describe))?$/.test(x.expression.getText(ast))) unsupported = true; ts.forEachChild(x, detect); } detect(n);
    }
    walk(ast); if (unsupported) fail('包含动态、跳过、独占或不支持的用例声明，请使用整份脚本编辑；单用例功能支持显式 test() 和 test.describe()');
    if (!items.length) fail('未找到可独立编辑的 test()'); return items;
}
export function replaceCase(code, id, replacement) { const all = cases(code), target = all.find(c => c.id === String(id)); if (!target) fail('用例不存在，请刷新'); const next = cases(replacement); if (next.length !== 1 || next[0].scope.length || replacement.slice(0, next[0].start).trim() || replacement.slice(next[0].end).trim()) fail('仅允许一个完整 test()，不能增加 import、公共函数或其他语句'); if (next[0].title !== target.title) fail('单用例修改须保留原测试名称'); const combined = code.slice(0, target.start) + replacement + code.slice(target.end); const check = checkScript(combined); if (!check.ok) fail(check.errors.join('；')); return { code: combined, before: target.code, after: replacement, caseId: target.id, title: target.title, baseHash: codeHash(code) }; }
export function selectCase(code, id) { const all = cases(code); if (!all.some(c => c.id === String(id))) fail('用例不存在'); let result = code; for (const c of [...all].reverse()) if (c.id !== String(id)) result = result.slice(0, c.start) + result.slice(c.start, c.end).replace(/[^\r\n]/g, ' ') + result.slice(c.end); return result; }
