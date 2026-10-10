import {list,put} from './db.mjs';
export function seed(){
if(list('project').length)return;
const p=put('project',{name:'示例 · 人员查询',baseURL:process.env.DEMO_BASE_URL||'http://127.0.0.1:8080',entry:'/demo',description:'内置演示页面，可验证完整执行链路。GCS 请另建项目。',auth:false});
put('suite',{projectId:p.id,name:'人员查询 · 冒烟测试',approved:false,code:`import { test, expect } from '@playwright/test';

test('按姓名查询人员', async ({ page }) => {
  await page.goto('/demo');
  await page.getByLabel('姓名').fill('王晓');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('王晓');
});

test('无匹配结果', async ({ page }) => {
  await page.goto('/demo');
  await page.getByLabel('姓名').fill('不存在的人员');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByText('暂无符合条件的人员')).toBeVisible();
});

test('重置查询条件', async ({ page }) => {
  await page.goto('/demo');
  await page.getByLabel('姓名').fill('王晓');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.getByLabel('姓名')).toHaveValue('');
  await expect(page.locator('tbody tr')).toHaveCount(3);
});`});
}
