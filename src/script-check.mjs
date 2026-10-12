import {locatorKey} from './locator-evidence.mjs';
import ts from 'typescript';
import {createHash} from 'node:crypto';
export const codeHash=code=>createHash('sha256').update(code).digest('hex');
export function checkEvidence(e,p,confirmed=true){const fail=s=>{throw Object.assign(new Error(s),{status:409});};if(e.projectId!==p.id||e.baseURL!==p.baseURL||e.entry!==p.entry)fail('页面依据与项目环境不一致，请重新采集');if((e.authSavedAt||null)!==(p.authSavedAt||null))fail('登录态已更换，请重新采集');if(!Number.isFinite(Date.parse(e.capturedAt))||Date.now()-Date.parse(e.capturedAt)>24*3600000)fail('采集结果已超过 24 小时，请重新采集');if(confirmed&&!e.confirmed)fail('请先确认业务规则和测试数据');}
export function checkScript(code,evidence){
 const errors=[];const ast=ts.createSourceFile('suite.spec.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 for(const d of ast.parseDiagnostics)errors.push(ts.flattenDiagnosticMessageText(d.messageText,' '));
 let tests=0;function walk(n){
  if(ts.isImportDeclaration(n)&&n.moduleSpecifier.text!=='@playwright/test')errors.push('仅允许导入 @playwright/test');
  if(ts.isIdentifier(n)&&['process','require','eval','Function','fetch','XMLHttpRequest','WebSocket'].includes(n.text))errors.push('包含不允许的全局能力：'+n.text);
  if(ts.isCallExpression(n)&&evidence&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='getByRole'){
   const [role,options]=n.arguments;
   if(role&&ts.isStringLiteral(role)&&role.text==='button'&&options&&ts.isObjectLiteralExpression(options)){
    const named=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==='name');
    if(named&&ts.isStringLiteral(named.initializer)){
     const name=named.initializer.text;
     let locator=n;const methods=new Set(['filter','locator','getByRole','getByText','getByLabel','getByPlaceholder','getByTestId']);
     while(ts.isPropertyAccessExpression(locator.parent)&&ts.isCallExpression(locator.parent.parent)&&methods.has(locator.parent.name.text))locator=locator.parent.parent;
     let statement=n;while(statement.parent&&!ts.isExpressionStatement(statement))statement=statement.parent;
     const hiddenAssertion=/\.toBeHidden\s*\(/.test(statement.getText(ast));
     const key=locatorKey(locator.getText(ast));
     const proven=evidence.controls.some(c=>c.candidates.some(x=>x.frameVerified!==false&&x.count===1&&(x.visible||hiddenAssertion)&&locatorKey(x.expression)===key));
     if(!proven)errors.push('按钮定位与已验证候选不一致：'+locator.getText(ast)+'；请使用证据中的完整定位表达式（含 iframe / 容器 / 可见过滤），不要仅按按钮名称匹配');
    }
   }
  }
  if(ts.isCallExpression(n)){const x=n.expression.getText(ast);if(n.expression.kind===ts.SyntaxKind.ImportKeyword)errors.push('禁止动态 import');if(x==='test')tests++;if(['test.skip','test.fixme','test.only'].includes(x))errors.push('存在跳过、待修复或独占用例');if(x.endsWith('.waitForTimeout'))errors.push('请用可重试断言替代固定等待');}
  ts.forEachChild(n,walk);
 }walk(ast);if(!tests)errors.push('未找到 test() 用例');return{ok:errors.length===0,errors:[...new Set(errors)],tests,codeHash:codeHash(code)};
}
