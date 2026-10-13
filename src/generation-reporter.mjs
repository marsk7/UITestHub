import {writeFileSync} from 'node:fs';
import path from 'node:path';
export default class GenerationReporter {
 constructor(){this.steps=[];this.ids=new Map();this.errors=[];this.testCount=0;}
 onStepBegin(test,result,step){if(!['pw:api','expect','test.step'].includes(step.category))return;this.ids.set(step,this.steps.length);this.steps.push({title:step.title,category:step.category,status:'running',location:step.location?{line:step.location.line,column:step.location.column}:null});}
 onStepEnd(test,result,step){const index=this.ids.get(step);if(index===undefined)return;Object.assign(this.steps[index],{status:step.error?'failed':'passed',duration:step.duration,error:step.error?.message?.slice(0,6000)||null});}
 onError(error){this.errors.push(error.message||String(error));}
 onTestEnd(test,result){this.testCount++;this.status=result.status;this.duration=result.duration;this.errors.push(...result.errors.map(e=>e.message||String(e)));this.attachments=result.attachments.filter(a=>a.name==='failure-page'&&a.body).map(a=>({name:a.name,body:a.body.toString('utf8')}));}
 onEnd(result){writeFileSync(path.join(process.cwd(),'verification.json'),JSON.stringify({finished:true,status:this.testCount===1?this.status:'error',runStatus:result.status,duration:this.duration,steps:this.steps,errors:this.errors,attachments:this.attachments||[]},null,2));}
}
