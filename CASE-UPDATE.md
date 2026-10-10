# TestHub 1.2.1 单用例功能增量更新

适用：已有 TestHub 1.2 MySQL 平台。不是独立完整安装包。
包内仅 src/、public/、checks/ 及本说明；不包含 Dockerfile、Compose、.env、数据库、登录态和模型凭据。没有新增依赖，无需修改 MySQL 表。

## 升级
1. 等待任务结束，备份当前源码和数据。
2. 将包中 testhub 下的 src、public、checks 三个目录内容合并覆盖到原 testhub 同名目录，保留所有其他文件。
3. 在原 testhub 目录执行：
   docker compose build api
   docker compose up -d --no-deps --force-recreate api worker
4. 刷新浏览器。保留你已经修复的软件源、证书、Dockerfile、Compose 和 .env；不要重新复制旧配置。

## 使用
测试脚本 → 单用例管理：
- 编辑此用例：修改完整 test()，保留测试名称，保存时只替换该片段。
- 重新生成：输入修改要求/错误证据，Worker 提交模型生成候选；到执行中心查看任务，点击“查看差异 / 应用”，人工接受后保存。模型接收整份脚本作为公共上下文和现有已确认页面依据，不接收登录态。
- 单条试运行：确认后仅执行选中 test()，继续执行公共前置/清理步骤，生成独立日志与报告。

修改记录保留最近 20 次 before/after；保存撤销整份审核与验证状态。脚本版本变化会拒绝旧候选，需重新生成。单条通过不伪装成整份通过；本更新尚未实现逐用例审核及产品缺陷豁免，整份审核门禁保持现状。
支持显式 test('名称', callback) 及命名 test.describe 分组，保留公共函数和 hooks。动态循环生成、test 别名、test.skip/only 等复杂声明会拒绝单用例模式，请使用整份编辑。需要增加 import 或修改公共 fixture 的改动仍需整份编辑。首次修复其他语法或静态问题可能需整份编辑。

验证：8 项通过（AST 定位及局部替换、约束、真实 Playwright 单条执行与 beforeEach、网页登录和采集回归、模拟 API 的界面编辑和重生成功能）。完整 MySQL/API/Worker 联调、真实 deepseek-flash 输出及 GCS 未在此环境验证；当前无 Docker/MySQL。部署后可执行 docker compose exec api npm run test:features（Dockerfile 已复制 checks 时）。
