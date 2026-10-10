import {chromium} from '@playwright/test';
import {mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
const url=process.argv[2],file=process.argv[3]||'local-auth.json';
if(!url){console.error('使用：npm run auth -- https://your-uat.example.com ./local-auth.json');process.exit(1);}
const browser=await chromium.launch({headless:false}),context=await browser.newContext(),page=await context.newPage();
try{await page.goto(url);const rl=readline.createInterface({input:process.stdin,output:process.stdout});await rl.question('请在浏览器中完成人工登录和验证码，进入目标页面后按回车保存登录态。');rl.close();await mkdir(path.dirname(path.resolve(file)),{recursive:true});await context.storageState({path:file,indexedDB:true});await chmod(file,0o600);console.log('登录态已保存，请在平台项目卡片上传；该文件包含会话凭证，请勿分享。');}finally{await browser.close();}
