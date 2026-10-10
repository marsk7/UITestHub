# MySQL 版本验证记录 · 2026-10-08

已执行：mysql2 安装及 lockfile 更新；全部 JS/MJS 语法检查；Shell 语法检查；Compose YAML 解析与服务依赖静态核对；确认运行时无 SQLite prepare/PRAGMA/同步数据库接口残留。

未执行：真实 MySQL 8.4 集成、SQLite 数据迁移实测、Docker 镜像构建、真实浏览器回归。原因：当前交付环境没有 Docker/MySQL 服务。原 SQLite 版本的浏览器通过记录不作为本版本验证结果。

在 Mac 启动 Docker Desktop 后运行 bash start.sh，然后 bash test-mysql.sh；完整浏览器回归运行 RUN_BROWSER_TESTS=1 bash test-mysql.sh。公司模型网关、GCS 内网及登录态仍需用户环境联调。
