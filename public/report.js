const status=document.querySelector('#report-status'),frame=document.querySelector('#report-frame');
async function load(){
 const id=new URLSearchParams(location.search).get('job');if(!/^[\w-]+$/.test(id||'')){status.textContent='任务编号不正确';return;}
 status.textContent='正在加载…';
 try{const r=await fetch('/api/jobs/'+id+'/report-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportPath:new URLSearchParams(location.search).get('path')||'html-report'})}),data=await r.json();if(!r.ok)throw new Error(data.error||'报告尚未生成');frame.src=data.url;status.textContent='已打开 · 访问有效至 '+new Date(data.expiresAt).toLocaleTimeString('zh-CN');}catch(e){status.textContent=e.message;frame.removeAttribute('src');}
}
document.querySelector('#reload-report').onclick=load;load();
