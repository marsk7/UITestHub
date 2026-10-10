# TestHub 1.2 验证记录 · 2026-10-09

已执行并通过 5 项功能测试：
1. TypeScript 语法与静态约束、缺少按钮依据拦截、项目/登录态/时间不匹配拦截。
2. 真实 Chromium 页面采集：定位计数、中文展开按钮、隐藏字段、列表仅采样三行、采集未提交查询、登录页面阻断。
3. 真实 Chromium 登录会话：点击、键盘、保存 Cookie/localStorage/IndexedDB，Cookie/localStorage 在新 context 复用；会话归属、确认、取消、过期。
4. 真实浏览器操作平台登录窗口（测试 HTTP 适配层）：输入、保存和资源关闭，无前端异常。
5. 真实浏览器操作新工作流界面（模拟 API）：依据确认、版本选择、生成提交、明确确认试运行，无前端异常。

验证命令：BROWSER_EXECUTABLE_PATH=<当前环境可用Chromium> BROWSER_ARGS_JSON='["--no-zygote","--disable-gpu"]' node --test checks/*.mjs。
已检查所有 JS/MJS 与 shell 语法、Compose YAML 和依赖锁定一致性。

尚未验证：完整 MySQL 队列/API/Worker 联调、Docker 镜像构建、真实模型 deepseek-flash、GCS DEV/UAT 与极验。当前环境无 Docker/MySQL 服务，以上功能测试不等同于整个平台验收。

已更新 tests/platform.test.mjs 的 MySQL 集成验收脚本，覆盖 explore→确认→generator→validate→审核门禁。请在部署环境执行 bash test-mysql.sh 和 RUN_BROWSER_TESTS=1 bash test-mysql.sh。测试使用独立数据库，不清除业务库。
