import {locatorFromSpec,locatorExpression,frameSelectors} from './locator-evidence.mjs';
import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function explore({project,storageState,dir,expand=true,signal,launch,agent,goals=[],maxSteps=6}){
 const browser=await (launch?launch():chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH,args:JSON.parse(process.env.BROWSER_ARGS_JSON||'[]')}:{})}));
 const abort=()=>browser.close().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw new Error('采集已取消');
  const context=await browser.newContext({viewport:{width:1280,height:800},...(storageState?{storageState}:{})});const page=await context.newPage();page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));const target=new URL(project.entry||'/',project.baseURL);
  if(target.origin!==new URL(project.baseURL).origin)throw new Error('入口地址必须属于项目环境');
  const response=await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000});if(response&&response.status()>=400)throw new Error('目标页面 HTTP '+response.status());
  await page.locator('body').waitFor();await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
  if(new URL(page.url()).origin!==target.origin||await page.locator('input[type=password]:visible').count())throw new Error('页面可能处于登录或认证状态，请先在项目中完成网页登录再采集');
  const warnings=[],actions=[];
  await mkdir(dir,{recursive:true,mode:0o700});
  const snapshots=[];
  const capture=async()=>{const snapshot=await collectPage(page,warnings);const stateId='state-'+snapshots.length;snapshot.controls=snapshot.controls.map(c=>({...c,stateId,prerequisites:[...actions]}));snapshots.push(snapshot);return snapshot;};
  let snapshot=await capture();
  const recommendations=[],used=new Set();
  const limit=Math.max(1,Math.min(8,Number(maxSteps)||6));
  const apply=async choice=>{
   const locator=locatorFromSpec(page,choice.spec);
   if(await locator.count()!==1||!await locator.isVisible())return false;
   await locator.click({timeout:5000});used.add(choice.key);actions.push('page.'+choice.expression+'.click()');
   await page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});
   if(new URL(page.url()).origin!==target.origin)throw new Error('探索离开项目环境，已停止');
   snapshot=await capture();await page.screenshot({path:path.join(dir,'step-'+actions.length+'.png'),fullPage:false});return true;
  };
  // Preserve the initial snapshot, then discover presentation-only expansion paths.
  if(expand)for(let step=0;step<limit;step++){
   if(signal?.aborted)throw new Error('采集已取消');
   const choice=explorationOptions(snapshot.controls).find(x=>x.actionType==='expand'&&!used.has(x.key));
   if(!choice)break;try{if(!await apply(choice))break;}catch(e){if(signal?.aborted)throw e;warnings.push('自动展开未完成，保留已有依据：'+e.message);break;}
  }

  if(agent){
   for(let step=0;actions.length<limit&&step<limit;step++){
    if(signal?.aborted)throw new Error('采集已取消');
    const options=explorationOptions(snapshot.controls).filter(x=>!used.has(x.key));
    let decision;try{decision=await agent({goals,step,controls:snapshot.controls,options:options.map(({key,role,name,expression,framePath,actionType})=>({key,role,name,expression,framePath,actionType})),actions:[...actions]});}catch(e){if(signal?.aborted)throw e;warnings.push('探索建议不可用，保留已采集依据：'+e.message);}
    if(decision?.suggestion)recommendations.push(String(decision.suggestion).slice(0,4000));
    if(!decision?.actionKey){const fallback=options.find(x=>x.actionType==='expand');if(!fallback)break;decision={...decision,actionKey:fallback.key};recommendations.push('模型未选择操作，平台执行已验证的展开控件以补充隐藏字段依据');}
    const choice=options.find(x=>x.key===decision.actionKey);if(!choice){warnings.push('模型提出了未授权或不存在的操作，已停止探索');break;}
    if(!await apply(choice)){warnings.push('探索控件已变化，未执行点击');break;}
   }
  }
  const controls=snapshots.flatMap(x=>x.controls),tables=snapshot.tables,frames=snapshot.frames;
  if(frames.some(f=>f.framePath===null))warnings.push('部分 iframe 无法唯一定位；这些控件不会标为可交互，需补充稳定的 frame 属性。');
  if(!controls.some(c=>c.usable))warnings.push('未发现唯一且可见的可用定位器；请检查页面加载、组件或登录状态。');
  warnings.push('仅采样当前可见列表前 3 行；样本不是完整数据集，也不能证明精确匹配、唯一性或权限规则。');
  await page.screenshot({path:path.join(dir,'page.png'),fullPage:false});
  const result={projectId:project.id,baseURL:project.baseURL,entry:project.entry,authSavedAt:project.authSavedAt||null,capturedAt:new Date().toISOString(),url:page.url().split(/[?#]/)[0],title:await page.title(),controls,tables,frames,actions,warnings,recommendations,confirmed:false};
  await writeFile(path.join(dir,'evidence.json'),JSON.stringify(result,null,2),{mode:0o600});return result;
 }finally{signal?.removeEventListener('abort',abort);await browser.close().catch(()=>{});}
}

async function collectPage(page,warnings){
  const controls=[],tables=[],frames=[];
  for(const [frameIndex,frame] of page.frames().entries()){
   if(frameIndex>=8){warnings.push('iframe 数量超过采集上限');break;}
   const frameUrl=frame.url().split(/[?#]/)[0],framePath=await frameSelectors(frame).catch(()=>null);frames.push({frameIndex,url:frameUrl,framePath});await frame.locator('body').waitFor({timeout:2500}).catch(()=>{});
   const items=await frame.locator('input:not([type=hidden]):not([type=password]),textarea,select,button,[role=button],[role=combobox],[role=textbox],[role=tab],[role=option],[role=alert],[role=status],.ant-empty-description,.el-empty__description,a,span,[aria-expanded]').evaluateAll(els=>[...els].filter(el=>el.tagName!=='SPAN'||!el.closest('button,a,[role=button]')&&/^(展开|展开查询|展开筛选|更多筛选|高级查询|高级筛选|Expand|More filters|Advanced search)$/i.test((el.textContent||'').trim())).sort((a,b)=>Number(!!b.getClientRects().length)-Number(!!a.getClientRects().length)).slice(0,240).map(el=>{
    const text=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,160);
    const label=text([...el.labels||[]].map(x=>x.textContent).join(' '));const aria=text(el.getAttribute('aria-label'));const labelled=text((el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' '));
    const group=el.closest('.ant-form-item,.el-form-item,fieldset,[role=group]');const contextLabel=text(group?.querySelector('label,legend,.ant-form-item-label,.el-form-item__label')?.textContent);
    const tag=el.tagName.toLowerCase();const role=el.getAttribute('role')||({button:'button',select:'combobox',textarea:'textbox',a:el.hasAttribute('href')?'link':''}[tag])||(tag==='input'?({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',number:'spinbutton',search:'searchbox'}[el.type]||'textbox'):'');
    return{tag,type:el.getAttribute('type'),role,label,ariaName:labelled||aria,nameHint:labelled||aria||label||(['button','a','span'].includes(tag)||el.hasAttribute('aria-expanded')||['tab','button','combobox','option','alert','status'].includes(role)||el.matches('.ant-empty-description,.el-empty__description')?text(el.textContent):''),id:el.id,fieldName:el.getAttribute('name'),contextLabel,contextSelector:group?.matches('.ant-form-item')?'.ant-form-item':group?.matches('.el-form-item')?'.el-form-item':group?.matches('fieldset')?'fieldset':group?'[role=group]':null,emptySelector:el.matches('.ant-empty-description')?'.ant-empty-description':el.matches('.el-empty__description')?'.el-empty__description':null,testId:el.getAttribute('data-testid'),placeholder:text(el.getAttribute('placeholder')),visible:!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'),disabled:!!el.disabled,expanded:el.getAttribute('aria-expanded'),selected:el.getAttribute('aria-selected'),options:tag==='select'?[...el.options].slice(0,20).map(o=>({label:text(o.textContent),value:o.value.slice(0,160)})):undefined};
   })).catch(()=>[]);
   for(const item of items){
    const candidates=[];
    const add=async(method,arg,options,scope)=>{
     const spec={frames:framePath||[],method,arg,...(options?{options}:{}),...(scope?{scope}:{})};
     try{
      const locator=framePath===null?frame[method](arg,options):locatorFromSpec(page,spec);
      const count=await locator.count(),visible=count===1?await locator.isVisible():false;
      candidates.push({expression:locatorExpression(spec),spec,count,visible,frameVerified:framePath!==null});
      if(count>1&&framePath!==null){const visibleSpec={...spec,visibleOnly:true},visibleLocator=locatorFromSpec(page,visibleSpec);if(await visibleLocator.count()===1)candidates.push({expression:locatorExpression(visibleSpec),spec:visibleSpec,count:1,visible:true,frameVerified:true});}
     }catch{}
    };
    if(item.testId)await add('getByTestId',item.testId);
    if(item.label||item.ariaName)await add('getByLabel',item.label||item.ariaName,{exact:true});
    if(item.role&&item.nameHint)await add('getByRole',item.role,{name:item.nameHint,exact:true});
    if(item.placeholder)await add('getByPlaceholder',item.placeholder,{exact:true});
    if(item.id)await add('locator','[id='+JSON.stringify(item.id)+']');
    if(item.fieldName)await add('locator',item.tag+'[name='+JSON.stringify(item.fieldName)+']');
    if(['a','span'].includes(item.tag)&&item.nameHint)await add('getByText',item.nameHint,{exact:true});
    if(item.emptySelector)await add('locator',item.emptySelector);
    if(item.contextLabel&&item.contextSelector)await add('locator',item.tag,undefined,{selector:item.contextSelector,text:item.contextLabel});
    controls.push({...item,frameIndex,framePath,candidates,usable:framePath!==null&&candidates.some(c=>c.count===1&&c.visible)});
   }
   const sampled=await frame.locator('table,[role=grid]').evaluateAll(els=>els.slice(0,5).map(el=>({headers:[...el.querySelectorAll('th,[role=columnheader]')].slice(0,20).map(x=>x.textContent.trim().slice(0,120)),rows:[...el.querySelectorAll('tbody tr,[role=row]')].filter(r=>r.getClientRects().length).slice(0,3).map(r=>[...r.querySelectorAll('td,[role=gridcell]')].slice(0,20).map(c=>c.textContent.trim().slice(0,120))).filter(r=>r.length)}))).catch(()=>[]);tables.push(...sampled.map(t=>({...t,frameIndex})));
  }

 return{controls,tables,frames};
}

// Only presentation controls; model-provided selectors/code are never evaluated.
export function explorationOptions(controls){
 const deny=/删除|保存|提交|新增|创建|审批|支付|确认|退出|注销|delete|save|submit|create|approve|pay|confirm|logout/i;
 const expandName=/^(展开|展开查询|展开筛选|更多筛选|高级查询|高级筛选|Expand|More filters|Advanced search)$/i;
 return controls.filter(c=>c.framePath!==null&&c.visible&&!c.disabled&&c.nameHint&&!deny.test(c.nameHint)&&(
  ((c.role==='button'||['a','span'].includes(c.tag))&&expandName.test(c.nameHint)&&c.expanded!=='true')||
  (c.role==='tab'&&c.selected!=='true')||(c.role==='combobox'&&c.tag!=='select'&&c.expanded!=='true')
 )).flatMap(c=>{const candidate=c.candidates.find(x=>x.count===1&&x.visible&&x.frameVerified!==false);return candidate?[{key:JSON.stringify(c.framePath||[])+':'+c.role+':'+c.nameHint,role:c.role,name:c.nameHint,framePath:c.framePath||[],actionType:expandName.test(c.nameHint)?'expand':c.role,expression:candidate.expression,spec:candidate.spec}]:[];}).filter((c,i,xs)=>xs.findIndex(x=>x.key===c.key)===i);
}
