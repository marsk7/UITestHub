import ts from 'typescript';
// Stable comparison of observed locator expressions, independent of quote/spacing style.
export function locatorKey(source){
 const ast=ts.createSourceFile('x.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const expr=ast.statements[0]?.expression;if(!expr)return '';
 function key(n){
  if(ts.isStringLiteralLike(n))return JSON.stringify(n.text);
  if(ts.isIdentifier(n))return n.text;
  if(ts.isPropertyAccessExpression(n))return key(n.expression)+'.'+key(n.name);
  if(ts.isCallExpression(n))return key(n.expression)+'('+n.arguments.map(key).join(',')+')';
  if(ts.isObjectLiteralExpression(n))return '{'+n.properties.map(p=>ts.isPropertyAssignment(p)?key(p.name)+':'+key(p.initializer):p.getText(ast)).sort().join(',')+'}';
  return n.getText(ast).replace(/\s/g,'');
 }
 return key(expr).replace(/^page\./,'');
}
export function locatorFromSpec(page,spec){
 let root=page;
 for(const selector of spec.frames||[])root=root.frameLocator(selector);
 if(spec.scope)root=root.locator(spec.scope.selector).filter({hasText:spec.scope.text});
 const {method,arg,options}=spec;
 if(!['locator','getByRole','getByLabel','getByPlaceholder','getByTestId','getByText'].includes(method))throw new Error('定位方法不支持');
 const locator=root[method](arg,options);return spec.visibleOnly?locator.filter({visible:true}):locator;
}
export function locatorExpression(spec){
 let root=(spec.frames||[]).map(s=>`frameLocator(${JSON.stringify(s)}).`).join('');
 if(spec.scope)root+=`locator(${JSON.stringify(spec.scope.selector)}).filter({hasText:${JSON.stringify(spec.scope.text)}}).`;
 return root+`${spec.method}(${JSON.stringify(spec.arg)}${spec.options?','+JSON.stringify(spec.options):''})`+(spec.visibleOnly?'.filter({visible:true})':'');
}
export async function frameSelectors(frame){
 if(!frame.parentFrame())return [];
 const parent=frame.parentFrame(),prefix=await frameSelectors(parent);if(prefix===null)return null;
 const el=await frame.frameElement();const attrs=await el.evaluate(e=>({tag:e.tagName.toLowerCase(),id:e.id,name:e.getAttribute('name'),title:e.getAttribute('title'),testId:e.getAttribute('data-testid')}));
 const choices=[attrs.id&&`${attrs.tag}[id=${JSON.stringify(attrs.id)}]`,attrs.testId&&`${attrs.tag}[data-testid=${JSON.stringify(attrs.testId)}]`,attrs.name&&`${attrs.tag}[name=${JSON.stringify(attrs.name)}]`,attrs.title&&`${attrs.tag}[title=${JSON.stringify(attrs.title)}]`,attrs.tag].filter(Boolean);
 for(const selector of choices)if(await parent.locator(selector).count()===1)return [...prefix,selector];
 return null;
}
export function evidenceSignature(e){return JSON.stringify({controls:(e.controls||[]).map(c=>[c.framePath,c.nameHint,c.kind,c.value,c.scrollTop,c.candidates.map(x=>[x.expression,x.count,x.visibleCount,x.visible])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),tables:e.tables||[]});}
export function compactEvidence(e){
 if(!e)return e;const seen=new Map();
 for(const c of e.controls||[]){
  const proven=c.candidates.filter(x=>x.frameVerified!==false&&(x.count===1||x.kind==='collection'));
  const candidates=(proven.length?proven:c.candidates.slice(0,1)).map(({expression,count,visibleCount,visible,frameVerified,kind})=>({expression,count,visibleCount,visible,frameVerified,kind}));
  const {candidates:ignored,...details}=c;
  const value={...details,candidates,prerequisites:c.prerequisites||[]};
  const key=JSON.stringify([c.framePath,c.nameHint,c.contextLabel,c.kind,c.visible,candidates]);
  if(!seen.has(key)||seen.get(key).prerequisites.length>value.prerequisites.length)seen.set(key,value);
 }
 return{...e,controls:[...seen.values()]};
}

// Preserve replayable prerequisite paths from earlier observations, with provenance.
// Never carry controls across a project/environment change. Authentication refresh does not erase page structure.
export function mergeEvidence(previous,current){
 if(!previous||['projectId','baseURL','entry'].some(k=>(previous[k]||null)!==(current[k]||null)))return current;
 const seen=new Map();
 for(const source of [previous,current])for(const c of source.controls||[]){
  const observedAt=c.observedAt||source.capturedAt;
  const value={...c,observedAt,sourceEvidenceId:c.sourceEvidenceId||source.id||null};
  const key=JSON.stringify([c.framePath,c.nameHint,c.contextLabel,c.prerequisites||[],c.candidates.map(x=>locatorKey(x.expression))]);
  seen.set(key,value);
 }
 const structures=new Map();for(const source of [previous,current])for(const t of source.tables||[])structures.set(JSON.stringify([t.framePath,t.selector||t.container?.expression,t.prerequisites||[]]),t);
 return {...current,controls:[...seen.values()].slice(-3000),tables:[...structures.values()].slice(-100)};
}
