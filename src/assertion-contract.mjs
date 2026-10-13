import ts from 'typescript';

// Conservative proposal gate, not a proof of semantic equivalence. Locators may
// change, but matcher names, negation and expected arguments may not disappear.
export function assertionContract(code){
 const ast=ts.createSourceFile('case.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),shapes=[];
 const printer=ts.createPrinter({removeComments:true});
 function walk(node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&/^to[A-Z]/.test(node.expression.name.text)){
   let root=node.expression.expression,negated=false;
   if(ts.isPropertyAccessExpression(root)&&root.name.text==='not'){negated=true;root=root.expression;}
   if(ts.isCallExpression(root)&&/^expect(?:\.(?:poll|soft))?$/.test(root.expression.getText(ast))){
    shapes.push(JSON.stringify({matcher:node.expression.name.text,negated,soft:root.expression.getText(ast)==='expect.soft',args:node.arguments.map(a=>printer.printNode(ts.EmitHint.Unspecified,a,ast))}));
   }
  }
  ts.forEachChild(node,walk);
 }
 walk(ast);return shapes.sort();
}
export function checkAssertionContract(before,after){
 const original=assertionContract(before),next=assertionContract(after);
 if(!original.length)return {ok:false,error:'原用例没有可识别的断言，请人工补充明确预期后再生成候选'};
 if(JSON.stringify(original)!==JSON.stringify(next))return {ok:false,error:'候选修改改变了断言数量、匹配方式、否定条件或预期值，已拒绝自动候选；请保留原断言或由人工明确修改业务规则'};
 if(/\bcatch\s*(?:\(|\{)|\.catch\s*\(|expect\.soft\s*\(/.test(after))return {ok:false,error:'候选包含吞异常或软断言风险，请人工检查'};
 return {ok:true};
}
