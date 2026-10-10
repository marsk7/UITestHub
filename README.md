# TestHub 1.1 · MySQL 版

在原版基础上将运行时 SQLite 替换为 MySQL 8.4 + mysql2。API、Worker 均使用异步连接池；队列事务领取；数据库级单 Worker 锁；子进程日志顺序写入并等待完成。文件产物继续保存在 testhub-data 卷。当前仍是单 API、单 Worker 的可信内部 MVP，未增加自主探索、Codex CLI、多租户或执行沙箱。

## Mac：先配置，再构建

1. 把新版源码放入原 testhub 目录（保留原 .env 和数据，不要同时运行旧版）。也可以使用新目录从空库开始，但 Compose 项目名改变会使用新数据卷。
2. 已有 .env 不要覆盖，参照 .env.example 补充 DB_NAME、DB_USER、DB_PASSWORD、MYSQL_ROOT_PASSWORD。新安装执行 `cp .env.example .env`。
3. 修改三个不同密码；ADMIN_PASSWORD 至少 12 位。密码建议使用长随机字母数字，避免 Compose 的 `$` 插值。模型配置可暂空。
4. `bash start.sh`：检查配置 → 构建 api 镜像 → 启动 MySQL → API 建表、初始化示例 → Worker。
5. `docker compose ps`、`docker compose logs --tail=100 mysql api worker`。
6. 打开 http://127.0.0.1:8080，密码为 ADMIN_PASSWORD；审核并运行内置三条人员查询测试。

.env 不进入镜像。默认镜像 testhub-ui:1.1-mysql；数据库镜像 mysql:8.4。MySQL 不映射宿主机端口，API/Worker 通过 mysql:3306 连接。Compose 强制 DB_HOST=mysql，当前配置用于内置数据库；接入公司数据库需要另改 Compose 的 host、依赖和 mysql 服务。

MySQL 初始化环境变量仅对空数据卷生效。已有 MySQL 卷不能仅修改 .env 就更换用户密码或创建新数据库，需在数据库内同步操作。切勿使用 down -v 清除已有数据。

## 开发与测试

`docker compose -f compose.yaml -f compose.dev.yaml up -d`

前端保存后刷新；后端保存后执行：
`docker compose -f compose.yaml -f compose.dev.yaml restart api worker`

集成测试（需先构建并启动 MySQL）：

```bash
bash test-mysql.sh
RUN_BROWSER_TESTS=1 bash test-mysql.sh
```

测试脚本创建独立 testhub_test_* 数据库，授权给应用用户，结束后清理；不会在业务库清表。覆盖登录、审核失效、模拟模型生成、取消；第二条额外验证真实浏览器、失败截图与 trace、报告下载和界面。

## 保留旧 SQLite 数据：在新版 API 首次启动前迁移

迁移是可选的；不迁移则 MySQL 是新库，原 SQLite 文件不修改。需保留原 Compose 项目名和 testhub-data 卷。

先在旧目录执行 `docker compose stop api worker`，备份完整数据卷（包含 testhub.db 及 WAL、auth/、runs/）。更新源码并配置 .env 后，不执行 start.sh，按以下顺序：

```bash
docker compose build api
docker compose up -d mysql
# 用 docker compose ps 确认 mysql 为 healthy，再执行：
docker compose run --rm --no-deps api npm run db:migrate -- /app/data/testhub.db
docker compose up -d --no-build
```

迁移要求目标三张表为空，否则拒绝。记录保留原 ID，任务历史保留；queued/running 标记 interrupted，避免自动重复业务操作。任务快照中的临时 storageState 被清除，项目 auth/ 文件保留。导入在事务内执行，失败回滚。检查项目、脚本、历史报告后再恢复测试。MySQL 数据和报告文件要分别备份。

## 发布至无网络服务器

确认服务器架构。以 x86_64 为例，在可联网 Mac：

```bash
docker buildx build --platform linux/amd64 --load -t testhub-ui:1.1-mysql .
docker pull --platform linux/amd64 mysql:8.4
docker save -o testhub-mysql-images.tar testhub-ui:1.1-mysql mysql:8.4
```

将 tar、compose.yaml、.env.example 传到服务器。服务器配置自己的 .env，然后：

```bash
docker load -i testhub-mysql-images.tar
docker compose up -d --no-build --pull never
```

不要把 Mac 的 .env、node_modules 或数据卷打进镜像。服务器数据独立；需要迁移时另做数据备份与恢复。发布前不加载 compose.dev.yaml，复测镜像内代码。

## 验证状态

见 VALIDATION.md。当前交付环境没有 Docker 或 MySQL 服务，不能把语法检查当作 MySQL 集成或 Docker 构建成功。
