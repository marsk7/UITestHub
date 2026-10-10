import {spawn} from 'node:child_process';
const children=['src/server.mjs','src/worker.mjs'].map(f=>spawn(process.execPath,['--env-file=.env',f],{stdio:'inherit'}));
let stopping=false;function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');}
for(const s of ['SIGINT','SIGTERM'])process.on(s,stop);
for(const c of children)c.on('exit',()=>stop());
