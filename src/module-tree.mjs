import {cases} from './case-scripts.mjs';
export function moduleCases(suite){
 let actual=[];try{actual=cases(suite.code||'');}catch{}
 if(!suite.manifest?.length)return actual.map(c=>({id:c.id,title:c.title,declarationId:c.id,status:'generated'}));
 return suite.manifest.map(c=>{const matches=actual.filter(x=>x.title===`[${c.id}] ${c.title}`);return {...c,status:matches.length===1?'generated':matches.length?'duplicate':'missing',declarationId:matches.length===1?matches[0].id:null};});
}
