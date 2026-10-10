import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(existsSync('.env')){console.log('.env already exists; preserved. Add MySQL settings if upgrading.');process.exit(0);}
const secret=()=>randomBytes(24).toString('hex');
writeFileSync('.env',`ADMIN_PASSWORD=${secret()}
DB_NAME=testhub
DB_USER=testhub
DB_PASSWORD=${secret()}
MYSQL_ROOT_PASSWORD=${secret()}
PORT=8080
LLM_BASE_URL=
LLM_MODEL=
LLM_API_KEY=
COOKIE_SECURE=false
`,{mode:0o600});
console.log('Created .env with random passwords. Review before building.');
