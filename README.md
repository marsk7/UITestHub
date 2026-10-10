# TestHub 1.2 · MySQL 版

在原版基础上将运行时 SQLite 替换为 MySQL 8.4 + mysql2。API、Worker 均使用异步连接池；队列事务领取；数据库级单 Worker 锁；子进程日志顺序写入并等待完成。文件产物继续保存在 testhub-data 卷。当前仍是单 API、单 Worker 的可信内部 MVP，新增确定性页面采集与平台内远程登录；未接入 Codex CLI、多租户或任务级执行沙箱。

## 1.2 新功能与操作顺序

1. 项目与环境 → 网页登录 → 打开登录页面。远程浏览器运行在 API 容器，操作画面传回当前窗口，不需要安装本机 Node。人工输入账号、密码、验证码；回到项目业务域名后勾选确认并保存。
2. 项目与环境 → 采集页面：Worker 使用项目登录态执行 explore。默认不点击，不提交查询、不增删改数据；可明确允许点击唯一的“展开 / 展开查询 / 展开筛选 / Expand”按钮。
3. 执行中心 → 采集任务 → 确认页面依据（也可从项目的“页面依据”进入）。查看截图、控件及候选定位、当前可见表格样本；填写业务规则，删减或脱敏测试数据，再确认。
4. 测试计划审核后 → 生成脚本 → 选择已确认的页面依据。不再要求手工粘贴 DOM。仅确认的数据及控件信息交给模型，原始表格采样不自动全部发送，截图和登录态不发送模型。
5. 测试脚本 → 检查 / 试运行：查看生成缺口与源码，确认执行范围后提交 validate。它会真实执行业务操作，请使用受控测试数据。
6. 根据试运行日志、截图、trace 修正脚本；当前版本不自动放宽断言或自动修复。基于页面证据生成的脚本需通过当前代码版本的试运行后，才可审核正式执行。修改脚本会清除审核与验证状态。

### 采集边界

- 采集控件类型、标签、角色名称候选、test id、可见性、禁用状态及原生下拉选项；对候选定位实际检查匹配数量和可见性。
- 最多 8 个 frame，每 frame 最多 180 个控件、5 张表，每表 3 行；不遍历全部菜单，不自动点开自定义下拉框、不采集后台数据库。
- iframe 控件记录为需补充依据；本版自动生成优先使用主页面已验证定位。异步组件、虚拟表格、自定义控件可能采集不完整，显示缺口后人工补充或重新采集。
- 采集记录绑定环境、入口及登录态保存时间。24 小时后或重新登录后需要重新采集。修改已确认规则/数据后，基于旧依据的脚本需要重新生成。
- 列表样本只能证明当前可见数据存在，不能推导唯一性、模糊/精确匹配规则或权限范围。请在规则中标明角色和待确认项。
- TypeScript AST 检查语法、导入、跳过、固定等待、部分危险调用，以及字面量按钮名称是否有采集依据；这不是安全沙箱，可信人员仍需审核脚本。

### 平台内登录边界

- 支持点击、拖动、滚动、键盘输入、粘贴及第三方弹出页切换。中文输入可用画面下方的输入框，先点击远程目标输入框再发送。
- 最多两个并发登录窗口，同一项目一个；15 分钟自动到期，退出工作台时关闭该会话的浏览器。取消不覆盖原登录态。
- 保存 Cookie、localStorage、IndexedDB；不包含 sessionStorage。登录态过期、设备/IP 绑定及 sessionStorage 依赖需要按系统实际机制适配。
- 保存按钮表示人工确认后保存浏览器状态，平台不声称已自动证明认证成功。极验等验证码必须人工操作；部分验证码可能限制远程/无头浏览器，兼容性需 GCS 实测，保留上传 JSON 入口。
- 登录画面和输入经平台 API 转发，不调用模型，不记录输入事件正文。画面截图仅在内存传输，不存入测试报告。请通过 localhost/SSH 转发或 HTTPS 访问。
- API 和 Worker 均需能访问 GCS。登录浏览器位于 API 容器，采集/测试位于 Worker 容器，共享登录态文件。

### 从 1.1 MySQL 升级

等待运行任务结束，关闭登录窗口，备份 MySQL 与 testhub-data。将 1.2 文件覆盖到原 testhub 目录，保留 .env 和原 Compose 项目名。执行 `bash start.sh` 重新构建；不要执行 `down -v`。仍沿用三张表，页面依据存于 records(kind=evidence)，无须清库。已有脚本可继续使用；新生成器必须选用确认后的采集结果。

## Mac：先配置，再构建

1. 把新版源码放入原 testhub 目录（保留原 .env 和数据，不要同时运行旧版）。也可以使用新目录从空库开始，但 Compose 项目名改变会使用新数据卷。
2. 已有 .env 不要覆盖，参照 .env.example 补充 DB_NAME、DB_USER、DB_PASSWORD、MYSQL_ROOT_PASSWORD。新安装执行 `cp .env.example .env`。
3. 修改三个不同密码；ADMIN_PASSWORD 至少 12 位。密码建议使用长随机字母数字，避免 Compose 的 `$` 插值。模型配置可暂空。
4. `bash start.sh`：检查配置 → 构建 api 镜像 → 启动 MySQL → API 建表、初始化示例 → Worker。
5. `docker compose ps`、`docker compose logs --tail=100 mysql api worker`。
6. 打开 http://127.0.0.1:8080，密码为 ADMIN_PASSWORD；审核并运行内置三条人员查询测试。

.env 不进入镜像。默认镜像 testhub-ui:1.2-mysql；数据库镜像 mysql:8.4。MySQL 不映射宿主机端口，API/Worker 通过 mysql:3306 连接。Compose 强制 DB_HOST=mysql，当前配置用于内置数据库；接入公司数据库需要另改 Compose 的 host、依赖和 mysql 服务。

MySQL 初始化环境变量仅对空数据卷生效。已有 MySQL 卷不能仅修改 .env 就更换用户密码或创建新数据库，需在数据库内同步操作。切勿使用 down -v 清除已有数据。

## 开发与测试

`docker compose -f compose.yaml -f compose.dev.yaml up -d`

前端保存后刷新；后端保存后执行：
`docker compose -f compose.yaml -f compose.dev.yaml restart api worker`

集成测试（需先构建并启动 MySQL）：

```bash
docker compose exec api npm run test:features
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
docker buildx build --platform linux/amd64 --load -t testhub-ui:1.2-mysql .
docker pull --platform linux/amd64 mysql:8.4
docker save -o testhub-mysql-images.tar testhub-ui:1.2-mysql mysql:8.4
```

将 tar、compose.yaml、.env.example 传到服务器。服务器配置自己的 .env，然后：

```bash
docker load -i testhub-mysql-images.tar
docker compose up -d --no-build --pull never
```

不要把 Mac 的 .env、node_modules 或数据卷打进镜像。服务器数据独立；需要迁移时另做数据备份与恢复。发布前不加载 compose.dev.yaml，复测镜像内代码。

## 验证状态

见 VALIDATION.md。当前交付环境没有 Docker 或 MySQL 服务，不能把语法检查当作 MySQL 集成或 Docker 构建成功。
