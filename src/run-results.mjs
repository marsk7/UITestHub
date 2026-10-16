// Keep each Playwright test/project result separate, including retries and setup errors.
export function caseResults(report){
 const rows=[];
 function walk(suites,parents=[]){for(const suite of suites||[]){const scope=[...parents,suite.title].filter(Boolean);for(const spec of suite.specs||[])for(const [index,t] of (spec.tests||[]).entries()){
  const attempts=t.results||[],last=attempts.at(-1),title=spec.title||'未命名用例';
  rows.push({id:title.match(/(?:TC|CASE)[-_]\d+/i)?.[0]?.toUpperCase()||spec.id||`${rows.length+1}`,key:`${spec.id||rows.length}:${t.projectName||index}`,title,scope,projectName:t.projectName||'',status:t.status==='expected'?'passed':t.status==='unexpected'?'failed':t.status||last?.status||'not-run',duration:attempts.reduce((n,r)=>n+(r.duration||0),0),errors:attempts.flatMap(r=>(r.errors||[]).map(e=>e.message||String(e))),steps:last?.steps||[],attempts:attempts.map(r=>({retry:r.retry,status:r.status,duration:r.duration}))});
 }walk(suite.suites,scope);}}walk(report?.suites);return rows;
}
