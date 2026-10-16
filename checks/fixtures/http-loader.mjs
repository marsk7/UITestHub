import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.includes('/src/')&&specifier==='./db.mjs')return {url:new URL('./memory-db.mjs',import.meta.url).href,shortCircuit:true};
 if(context.parentURL?.endsWith('/src/server.mjs')&&specifier==='./seed.mjs')return {url:'data:text/javascript,export async function seed(){}',shortCircuit:true};
 return next(specifier,context);
}});
