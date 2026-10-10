# TestHub · UI 自动化测试平台 v1.0

可部署的单工作空间 MVP：中文前端 + Node.js API + SQLite 持久化队列 + 独立 Playwright Worker。交付日期：2026-10-08。

## 已实现

- 项目环境独立配置：名称、Base URL、入口路径、人工登录态上传；不把业务地址写死在 Compose。
- 需求 → Planner 计划 → 人工编辑和审核 → Generator 脚本 → 人工编辑和审核 → Playwright 执行 → Reporter 分析。
- 不配置模型也能手工创建计划和脚本，运行内置人员查询示例。
- 提交执行时保存脚本、项目和登录态快照，后续编辑不会改变已提交任务。
- 脚本/计划修改自动撤销审核；未审核不允许进入下一阶段。
- 持久化任务队列、运行取消、日志轮询、Worker 心跳、异常中断状态。
- Chromium 实际执行，HTML / JSON 报告；失败保留 trace、截图、视频；产物打包下载。
- 管理员密码登录、HttpOnly 会话、同源写入校验、登录频率限制。

## 1. Docker 部署

建议先部署到能够访问目标 UAT 的 Linux 服务器。Docker Engine + Compose v2 即可，服务器不需要额外安装 Node。镜像构建需要访问 Docker Hub、npm 和 Playwright 浏览器下载源。

```bash
unzip TestHub-UI-Automation-v1.0.zip
cd testhub
bash start.sh
```

首次启动生成 `.env` 和随机管理员密码，请保存终端显示的密码。后续启动保留配置。访问 `http://127.0.0.1:8080`，使用该密码登录。

部署在远程服务器时，从本机执行：

```bash
ssh -L 8080:127.0.0.1:8080 your-user@your-server
```

保持 SSH 窗口打开，本机浏览器访问 `http://127.0.0.1:8080`。如果本地 8080 已占用，将 `-L` 改为 `18080:127.0.0.1:8080` 并访问 18080。

默认仅监听宿主机 loopback。面向团队使用时，在服务器配置 HTTPS 反向代理到 127.0.0.1:8080，再设置 `COOKIE_SECURE=true` 并重建容器；反向代理保留原始 Host。不要直接把本工具无保护地暴露到公网。

```bash
docker compose ps
docker compose logs -f api worker
# 修改 .env 后重建服务，使环境变量生效
docker compose up -d --force-recreate
# 停止但保留数据库和报告
docker compose down
```

不要运行 `docker compose down -v`，除非明确要清除全部数据。升级前停止两个服务并备份 Docker named volume `testhub-data`（实际名字含 Compose 项目前缀）。SQLite、登录态和报告都在该卷。

## 2. 先验证完整执行链路

1. 登录后进入「测试脚本」。
2. 打开内置「人员查询 · 冒烟测试」，检查源码，点击「审核通过」。
3. 点击「运行测试」，确认后进入执行中心。
4. 内置 `/demo` 有 3 条虚构人员记录。预期 3 条测试通过：姓名查询、无匹配结果、重置查询。
5. 在任务详情查看统计和日志，下载 `artifacts.zip`。
6. 解压后，在有 Playwright 的环境执行 `npx playwright show-report html-report`。失败 trace 使用 `npx playwright show-trace path/to/trace.zip` 打开。

以上是部署后的验收步骤；本交付的实际验证范围以 `VALIDATION.md` 为准。全部跳过会显示「全部跳过」，不会计为通过；Worker 崩溃中的任务标为「已中断」，不会自动重试业务操作。

## 3. 配置模型接口

修改 `.env`：

```dotenv
LLM_BASE_URL=https://your-company-model-gateway.example/v1
LLM_MODEL=your-model-id
LLM_API_KEY=your-key
```

`LLM_BASE_URL` 应为兼容 Chat Completions 的接口根地址，例如以 `/v1` 结尾，**不要再追加 `/chat/completions`**，平台会追加。模型名必须以网关实际支持的 ID 为准，不预设 DeepSeek 或其他模型名称。

```bash
docker compose up -d --force-recreate
```

查看「平台设置」确认地址、模型已加载。API Key 不发送到前端。默认每次生成超时 120 秒，失败不会伪造内容。平台不依赖模型 metadata 注册信息，也不调用 Codex CLI，因此此前 Codex 的模型 metadata 警告不属于本版本的运行链路。

使用 AI 功能会将你输入的需求、定位信息或执行日志发送至配置的模型服务；请选择公司允许使用的模型网关。Planner / Generator / Reporter 是本平台自定义的提示词工作流，**不是 Playwright 官方 Test Agents，也没有内嵌 Codex CLI、MCP Explorer 或自动 healer**。

## 4. 接入 GCS 人员管理查询

在「项目与环境」中新建项目：

```text
名称：GCS UAT
环境地址：https://gcsuat.juneyaoair.com
入口路径：/organization/personManager
```

Worker 所在容器必须能访问公司 DNS、代理和 UAT 网络。Base URL 用于 Playwright 配置；入口路径提供给生成器，手工脚本应显式使用 `page.goto('/organization/personManager')`。示例项目仅访问内置页面，并不假冒 GCS 的真实页面结构。

### 人工登录与登录态

在可以打开真实浏览器且支持当前 Playwright 版本的电脑上：

```bash
npm ci
npx playwright install chromium
npm run auth -- https://gcsuat.juneyaoair.com ./local-auth.json
```

浏览器中人工完成登录、极验并进入业务页面，再回终端按回车，文件才会保存。到 GCS 项目点击「上传登录态」，上传该 JSON。登录态包含 cookies、localStorage，以及可支持的 IndexedDB；不包含 sessionStorage。如果系统依赖 sessionStorage、设备绑定、IP 限制或短期 token，需按实际认证流程适配，不能保证跨电脑复用。

对于你之前的 macOS 12.7.6 / Node 20 / Playwright 1.45 环境，建议在**原有可用的 Playwright 1.45 项目**执行：

```bash
npx playwright codegen --save-storage=local-auth.json https://gcsuat.juneyaoair.com
```

人工完成登录后正常关闭录制窗口，再检查 JSON 是否存在并上传。不要把本平台的 Node 24 依赖混装到旧项目；旧版本保存的 cookies/localStorage 是否足够，需要在 UAT 验证。本平台及 Worker 优先放在 Linux Docker 内运行。

### Planner 输入例子

```text
只测试 GCS /organization/personManager 人员查询，不新增、修改或删除业务数据。
已确认规则：在这里填写真实规则，例如姓名是否模糊匹配、工号是否精确匹配、
多条件是否取交集、查询后分页是否归一、重置后默认范围、不同角色的数据权限。
覆盖：单条件、多条件、空条件、无匹配、首尾空格、特殊字符、重置、分页联动。
每条用例写出前置数据、操作步骤、可验证预期。不确定规则标为待确认。
```

计划通过审核后，Generator 要求填入实际页面定位依据：label、role、test id、DOM 片段和测试数据。不会自行访问页面，也不应根据字段名猜选择器。没有足够依据的测试应跳过并写明原因。检查生成脚本中所有 `test.skip`，补齐依据后再审核。

## 5. 本地开发

需要 Node.js 24+（使用内置 `node:sqlite`），zip 命令用于打包报告。

```bash
npm ci
node scripts/setup.mjs
npx playwright install --with-deps chromium
npm run dev
```

本地启动默认示例地址为 `http://127.0.0.1:8080`；如果修改 `PORT`，第一次启动前同时设置 `DEMO_BASE_URL`。已有项目需在界面手工改环境地址。SQLite 文件默认放在 `./data`。

```bash
npm test
# 包含浏览器、失败证据和界面回归（需已安装 Chromium）
RUN_BROWSER_TESTS=1 npm test
```

对于企业已经安装了兼容 Chromium 的环境，可以在 Worker 中配置 `BROWSER_EXECUTABLE_PATH`，必要时用 `BROWSER_ARGS_JSON` 传入 JSON 字符串数组。正常 Docker 部署无需设置这些变量。外部浏览器路径在宿主机与容器中不通用。

## 6. 结构与边界

```text
public/             中文界面、内置人员查询示例
src/server.mjs      HTTP API、登录、审核、报告下载
src/db.mjs          SQLite 数据与队列
src/worker.mjs      模型工作流、Playwright 子进程、报告收集
src/seed.mjs        可审核的示例测试
scripts/            初始化、开发启动、人工保存登录态
 tests/             集成测试（模型调用使用本地 mock）
compose.yaml        API 与 Worker，共享持久卷
Dockerfile          Node 24 + 精确锁定的 Playwright 和 Chromium
```

运行时关系：浏览器 → API → SQLite 队列 → Worker → 目标 UAT / 模型接口；Worker 将真实结果写回，前端每 4 秒刷新列表和任务日志。API/Worker 分进程，首版使用单 Worker 串行执行，不支持水平扩容。

- **这是可部署的内部 MVP，不是已经完成公司生产验收的系统。**
- 单管理员密码、单工作空间；未提供 SSO、细分 RBAC、多租户隔离、审计签名。
- 脚本在 Worker 子进程执行，有该容器用户的文件/网络权限。生成提示词的约束不是安全沙箱。仅允许可信人员审核/运行脚本，不对不可信用户开放。生产需要每任务独立隔离执行器及最小化凭据挂载。
- 未实现自动网页探索、用例版本差异比较、定时任务、Git 仓库同步、自动修复、禅道缺陷回写。不要将这些视为已交付功能。
- 任务详情目前自动刷新日志，完成后点击「刷新详情」更新最终统计和产物。
- SQLite/报告只保存在你的部署卷，不是 SaaS。数据未做应用层加密，应保护服务器、卷和备份。人工登录态运行后从任务目录清理；项目登录态仍保留供后续执行。
- 取消不能回滚网页已产生的副作用；真正中断执行有短暂延迟。异常结束后由人员决定是否重跑。
- 不自动把失败断言认定为产品缺陷，不自动将模型建议提交到开发仓库。

## 7. 故障排查

| 现象 | 检查与处理 |
|---|---|
| 镜像拉取证书域名不匹配 | 检查 Docker Desktop/daemon 代理、DNS、公司 TLS 检查和证书链；不要关闭 TLS 验证来掩盖问题。 |
| Playwright 浏览器下载失败 | 检查下载域名访问和企业代理；可在联网构建机完成镜像后 `docker save` / `docker load` 到服务器。 |
| Worker 离线 | 查看 `docker compose logs worker`，确认数据卷权限和单 Worker 约束。异常退出后可能等待约 15 秒心跳过期。 |
| Project chromium not found | 平台为每次任务显式生成名为 chromium 的项目。导入的脚本无需自带配置。 |
| No tests found | 生成文件固定为 suite.spec.ts，配置显式 testMatch。检查内容是否真的调用 test()，查看日志中的语法错误。 |
| GCS 跳到登录页 | 重新保存登录态；检查登录态有效期、域名、IP 和 sessionStorage 依赖。 |
| API Key 无效 / HTTP 401 | 检查 `.env`、网关根地址及模型名，修改后 force-recreate；不要在日志中打印 Key。 |
| 脚本通过但全部 skip | 平台显示「全部跳过」，补齐定位证据、取消 skip 后重新审核。 |
| 内置示例无法访问 | Docker 下示例地址应为 http://api:8080；本地开发应为 http://127.0.0.1:8080。 |

Playwright 官方依据：[Docker](https://playwright.dev/docs/docker)、[Authentication](https://playwright.dev/docs/auth)、[Reporters](https://playwright.dev/docs/test-reporters)。依赖与安装的浏览器版本必须匹配；本项目用 lockfile 和同一次镜像构建的安装命令保持一致。
