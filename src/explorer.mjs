import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function explore({project,storageState,dir,expand=false,signal,launch}){
 const browser=await (launch?launch():chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:JSON.parse(process.env.BROWSER_ARGS_JSON||'[]')}:{})}));
 const abort=()=>browser.close().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw new Error('采集已取消');
  const context=await browser.newContext({viewport:{width:1280,height:800},...(storageState?{storageState}:{})});const page=await context.newPage();const target=new URL(project.entry||'/',project.baseURL);
  if(target.origin!==new URL(project.baseURL).origin)throw new Error('入口地址必须属于项目环境');
  const response=await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000});if(response&&response.status()>=400)throw new Error('目标页面 HTTP '+response.status());
  await page.locator('body').waitFor();await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
  if(new URL(page.url()).origin!==target.origin||await page.locator('input[type=password]:visible').count())throw new Error('页面可能处于登录或认证状态，请先在项目中完成网页登录再采集');
  const warnings=[],actions=[];
  // Only expand an explicitly requested, uniquely named, visible toggle. Never submit forms.
  if(expand){const toggle=page.getByRole('button',{name:/^(展开|展开查询|展开筛选|Expand)$/i});if(await toggle.count()===1&&await toggle.isVisible()){await toggle.click();actions.push('点击已存在且唯一的展开按钮');}else warnings.push('未找到唯一可见的展开按钮，保持原页面状态；隐藏区域需要补充依据。');}
  await mkdir(dir,{recursive:true,mode:0o700});
  const controls=[],tables=[],frames=[];
  for(const [frameIndex,frame] of page.frames().entries()){
   if(frameIndex>=8){warnings.push('iframe 数量超过采集上限');break;}
   const frameUrl=frame.url().split(/[?#]/)[0];frames.push({frameIndex,url:frameUrl});
   const items=await frame.locator('input:not([type=hidden]):not([type=password]),textarea,select,button,[role=button],[role=combobox],[role=textbox],a').evaluateAll(els=>els.slice(0,180).map(el=>{
    const text=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,160);
    const label=text([...el.labels||[]].map(x=>x.textContent).join(' '));const aria=text(el.getAttribute('aria-label'));const labelled=text((el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '));
    const tag=el.tagName.toLowerCase();const role=el.getAttribute('role')||({button:'button',select:'combobox',textarea:'textbox',a:el.hasAttribute('href')?'link':''}[tag])||(tag==='input'?({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',number:'spinbutton',search:'searchbox'}[el.type]||'textbox'):'');
    return{tag,type:el.getAttribute('type'),role,label,ariaName:labelled||aria,nameHint:labelled||aria||label||(['button','a'].includes(tag)?text(el.textContent):''),id:el.id,testId:el.getAttribute('data-testid'),placeholder:text(el.getAttribute('placeholder')),visible:!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'),disabled:!!el.disabled,options:tag==='select'?[...el.options].slice(0,20).map(o=>({label:text(o.textContent),value:o.value.slice(0,160)})):undefined};
   })).catch(()=>[]);
   for(const item of items){const candidates=[];const add=async(locator,expression)=>{try{const count=await locator.count();candidates.push({expression,count,visible:count===1?await locator.isVisible():false});}catch{}};
    const q=JSON.stringify;
    if(item.testId)await add(frame.getByTestId(item.testId),`getByTestId(${q(item.testId)})`);
    if(item.label||item.ariaName)await add(frame.getByLabel(item.label||item.ariaName,{exact:true}),`getByLabel(${q(item.label||item.ariaName)},{exact:true})`);
    if(item.role&&item.nameHint)await add(frame.getByRole(item.role,{name:item.nameHint,exact:true}),`getByRole(${q(item.role)},{name:${q(item.nameHint)},exact:true})`);
    if(item.placeholder)await add(frame.getByPlaceholder(item.placeholder,{exact:true}),`getByPlaceholder(${q(item.placeholder)},{exact:true})`);
    if(item.id)await add(frame.locator('[id='+q(item.id)+']'),`locator(${q('[id='+q(item.id)+']')})`);
    controls.push({...item,frameIndex,candidates,usable:frameIndex===0&&candidates.some(c=>c.count===1&&c.visible)});
   }
   const sampled=await frame.locator('table,[role=grid]').evaluateAll(els=>els.slice(0,5).map(el=>({headers:[...el.querySelectorAll('th,[role=columnheader]')].slice(0,20).map(x=>x.textContent.trim().slice(0,120)),rows:[...el.querySelectorAll('tbody tr,[role=row]')].filter(r=>r.getClientRects().length).slice(0,3).map(r=>[...r.querySelectorAll('td,[role=gridcell]')].slice(0,20).map(c=>c.textContent.trim().slice(0,120))).filter(r=>r.length)}))).catch(()=>[]);tables.push(...sampled.map(t=>({...t,frameIndex})));
  }
  if(frames.length>1)warnings.push('包含 iframe；仅主页面候选定位可直接使用，iframe 路径需要人工补充确认。');
  if(!controls.some(c=>c.usable))warnings.push('未发现唯一且可见的可用定位器；请检查页面加载、组件或登录状态。');
  warnings.push('仅采样当前可见列表前 3 行；样本不是完整数据集，也不能证明精确匹配、唯一性或权限规则。');
  await page.screenshot({path:path.join(dir,'page.png'),fullPage:false});
  const result={projectId:project.id,baseURL:project.baseURL,entry:project.entry,authSavedAt:project.authSavedAt||null,capturedAt:new Date().toISOString(),url:page.url().split(/[?#]/)[0],title:await page.title(),controls,tables,frames,actions,warnings,confirmed:false};
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
 }finally{signal?.removeEventListener('abort',abort);await browser.close().catch(()=>{});}
}
