import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(existsSync('.env')){console.log('.env already exists; preserved.');process.exit(0);}
const password=randomBytes(18).toString('base64url');
writeFileSync('.env',`ADMIN_PASSWORD=${password}\nPORT=8080\nLLM_BASE_URL=\nLLM_MODEL=\nLLM_API_KEY=\nCOOKIE_SECURE=false\n`,{mode:0o600});
console.log('已生成 .env。平台管理员密码：'+password+'\n请保存密码，不要提交或分享 .env。');
