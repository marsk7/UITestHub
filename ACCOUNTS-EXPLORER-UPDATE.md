# TestHub v1.3.0：页面探索、账号权限与执行详情

此包为累计源码更新，可覆盖 TestHub 1.2.4 / 1.2.5 项目根目录。包含先前的报告在线查看、缺失用例补齐、单用例编辑和生成验证功能。它不是 Docker 镜像，也不是完整的新项目；需要保留原项目的 package.json、package-lock.json、Dockerfile、Compose 和 .env。

## 本次改动

- Explorer 默认先记录初始页面，再自动点击唯一、可见的已验证展开控件，记录展开后字段和可重放操作路径。支持按钮、链接和文字 span；不会点击保存、提交、查询、删除。支持的展开名称包括展开、展开查询、展开筛选、更多筛选、高级查询、高级筛选及对应英文名称。含糊不清的图标仍需定向探索或稳定属性，不能保证任意页面都可自动识别。
- 生成器明确区分“交互前置条件”和“测试预期”：默认折叠不是额外测试点；只对当前用例必需且未验证的字段报告缺口，其他隐藏字段不阻塞。证据不足时继续用既有的有界 Explorer 恢复流程，只重试未生成用例。
- 更换登录态、采集超过 24 小时不再使已有页面依据失效。环境地址或入口改变仍需重新采集；真实执行或重新探索仍需要有效登录态。旧依据并不保证页面未变化，遇到实际定位失败时再定向更新。
- 确认依据时业务规则可留空，以审核后的计划为准；仍保留测试数据确认。不会臆造计划缺失的业务预期。
- 执行详情按用例折叠，显示生成状态、执行步骤、错误与本用例报告；Explorer 建议、全量日志、分析和产物列表分别折叠。支持展开/折叠全部用例。历史任务若存在不超过 10 MB 的 results.json，也会提取用例明细；其他历史任务可继续查看 HTML 报告。
- 人员管理支持新增账号、角色/项目授权、启用/停用、重置密码。用户可修改自己的密码。账号停用代替物理删除，保留历史关联。

## 角色及数据权限

| 能力 | 管理员 | 测试人员 | 只读人员 |
| --- | --- | --- | --- |
| 查看项目、计划、脚本、任务、报告、下载 | 全部项目 | 获授权项目 | 获授权项目 |
| 管理人员、分配项目 | 是 | 否 | 否 |
| 配置环境和共享登录态 | 是 | 否 | 否 |
| 管理计划、确认依据、生成/修改/删除/恢复脚本、采集页面 | 是 | 获授权项目 | 否 |
| 执行已审核脚本 | 是 | 获授权项目 | 否 |
| 试运行未审核代码、生成时浏览器验证、审核脚本 | 是 | 否 | 否 |

Playwright 脚本拥有 Worker 进程能力，因此未审核脚本的执行与最终批准由管理员负责。项目授权在服务端检查，覆盖直接接口、下载与报告资源；不是仅隐藏菜单。管理员自动可见全部现有和后续项目。普通账号新建后无项目权限，必须分配。账号权限调整、停用、密码重置会撤销已有会话和报告链接；排队/运行任务在后续权限检查时停止，不撤销已经发生的业务操作。不是容器级多租户代码隔离。

## 初次升级登录

API 启动时自动新增 MySQL `users` 表，不重建原表、不清空已有数据。

- 当 `users` 表为空时，创建账号 `admin`，初始密码使用现有 `.env` 中的 `ADMIN_PASSWORD`。
- 后续密码保存在数据库中（scrypt 加盐哈希）。修改 `.env` 的 ADMIN_PASSWORD 不再重置该账号密码；通过个人修改密码或其他管理员重置。
- 原单密码登录接口仍兼容，省略 username 按 admin 处理；新界面使用账号和密码。
- 修改当前管理员自身权限时禁止停用/降权；至少保留一名启用管理员。
- 升级会使旧的内存登录会话失效，需要重新登录。

## 更新和重建（保留原数据卷）

在现有项目目录操作；保持原 Compose 项目名、目录和卷配置。不要执行 `docker compose down -v`，也不要删除 MySQL 或 testhub-data 卷。

先备份源码、.env、数据库和 data 卷。下面命令使用现有 Compose 服务名 api、worker、mysql：

```bash
mkdir -p backups
# 停止写入，MySQL 保持运行
docker compose stop api worker
# 容器内读取原数据库凭证，避免将密码写在命令行
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -u"$MYSQL_USER" --single-transaction --no-tablespaces "$MYSQL_DATABASE"' > backups/pre-1.3.0.sql
docker compose run --rm --no-deps --entrypoint tar api -czf - -C /app/data . > backups/pre-1.3.0-data.tar.gz
```

确认备份成功后，将本 ZIP 中的 src、public、checks、tests 和说明文件覆盖至原项目根目录（ZIP 没有多一层 testhub 目录）。保留部署配置和数据卷，不在新目录另起 Compose 项目。然后：

```bash
docker compose build api
docker compose up -d --no-deps --force-recreate api worker
docker compose ps
docker compose logs --tail=100 api worker
```

此命令针对现有 api 构建、api/worker 共用同一镜像的 Compose 配置。如果你的配置为两个服务分别 build，则执行 `docker compose build api worker`。包内不包含 .env、部署配置、登录态、数据或依赖目录，不覆盖原有镜像源/字体下载修复。api 健康后再启动 Worker 的原依赖关系保留。

部署后以 admin 登录，进入“人员管理”创建普通账号，分配项目，并确认其只能访问对应项目。重新登录业务系统后，可以直接选择旧页面依据生成；规则留空也可确认。

回滚前先停止 api/worker，再恢复备份源码或旧镜像。新增 users 表可保留，但旧版本不支持账号/项目权限，不应继续向普通账号开放访问。已有业务数据不因源码回滚自动恢复。

## 验证与限制

本次本地验证：32 项功能检查通过，包括真实 Chromium 的自动展开、iframe 与表单定位、登录态采集、报告在线查看、单用例编辑、生成验证、可选规则和人员界面。新增权限测试启动真实 API 和账号/密码/会话代码，但使用内存数据库适配器，验证项目隔离、只读限制、旧证据确认、报告授权撤销、账号并发版本保护与密码修改。

本环境无 MySQL 服务和 Docker，未执行真实 MySQL 建表/事务测试或 Docker 构建；未连接 GCS DEV 或真实 DeepSeek 模型。请在测试环境完成升级验收后用于日常测试。真实 MySQL 端到端检查保留于 tests/platform.test.mjs，只能使用空的 `testhub_test_*` 专用数据库，不能对生产库运行。

```bash
# 安装已有项目依赖及其匹配的 Chromium 后运行
node --test checks/*.mjs
# 需另行配置 DB_HOST / DB_USER / DB_PASSWORD / DB_NAME=testhub_test_* 专用空库
node --test tests/*.test.mjs
```
