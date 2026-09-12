# 部署与数据存储

> 业务数据必须由部署端持久化，浏览器不是数据源。Cloudflare 使用 D1；Docker 和 Node 使用服务端文件。Cookie 或浏览器存储仅可用于非敏感界面偏好和短期缓存。

## 选择部署方式

| 方式 | 后台监控 | 业务数据 | 密钥 | 适用场景 |
| --- | --- | --- | --- | --- |
| Cloudflare Worker + D1 | Cron Trigger | D1 | Worker Secrets | 最少运维，推荐 |
| Docker Compose | Node 定时器 | `/data/app-state.json` | 环境变量或 `/data/notification-config.json` | VPS、NAS、容器平台 |
| Node.js | Node 定时器 | `APP_STATE_FILE` | 环境变量或服务端配置文件 | 自定义进程管理和代理 |
| Cloudflare Pages | 不支持 | 不保存 | 不适用 | 静态演示 |

所有正式部署都使用相同接口：

```text
浏览器 -> /api/app-state -> 部署端存储
浏览器 -> /api/stock     -> 店铺接口
后台任务 ----------------> 店铺接口 -> 事件和通知
```

前端读取和修改的是服务端状态。每次写入携带修订号；后台任务已经更新数据时，旧页面会收到 `409` 并重新加载，避免直接覆盖较新的库存。

## 部署到 Cloudflare

需要 Node.js 20 或更高版本和 Cloudflare 账号。D1 数据库可以由下方的一键脚本自动创建，也可以手动创建。

### 一键自动部署

项目提供自动化脚本，可自动完成 Wrangler 登录检查、D1 创建或复用、`DB` 绑定写入、远程迁移、Worker 发布和管理口令 Secret 设置：

```powershell
npm install
npm run deploy:cloudflare:auto
```

脚本优先使用现有 Wrangler 登录状态；未登录时会自动打开浏览器。CI 或无浏览器环境可设置 `CLOUDFLARE_API_TOKEN` 后执行。首次未提供 `ADMIN_TOKEN` 时脚本会生成随机口令并只在终端显示一次。需要更换数据库名称时设置 `CLOUDFLARE_D1_NAME`。

1. 安装依赖并登录。

```powershell
npm install
npx wrangler login
```

2. 创建 D1 数据库。

```powershell
npx wrangler d1 create stock-watch-monitor
```

3. 将命令返回的 Database ID 写入 `wrangler.toml` 的 D1 绑定配置。

```toml
[[d1_databases]]
binding = "DB"
database_name = "stock-watch-monitor"
database_id = "命令返回的 Database ID"
```

`binding` 必须是 `DB`。Database ID 不是密码，可以保存在配置文件中。

4. 应用数据库迁移。

```powershell
npx wrangler d1 migrations apply stock-watch-monitor --remote
```

5. 设置管理口令和需要的通知密钥。

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put FEISHU_WEBHOOK
```

只需设置实际使用的通知渠道。`ADMIN_TOKEN` 必须设置，页面通过它读取和修改 D1 状态。

6. 发布。

```powershell
npm run deploy
```

发布后打开 Wrangler 输出的 `workers.dev` 地址。Worker Cron 每 5 分钟唤醒一次，并按照页面保存的间隔决定是否执行库存检查。

## 部署到 Docker

1. 创建配置文件。

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

2. 在 `.env` 中设置至少 8 位 `ADMIN_TOKEN`。接入真实店铺时同时配置 `DEMO_MODE` 和上游地址。

3. 启动容器。

```powershell
docker compose up -d --build
docker compose logs -f
```

4. 打开 `http://服务器地址:8788`。

Compose 将仓库的 `data/` 映射到容器 `/data`。需要备份时保存整个 `data/` 目录，其中包括：

| 文件 | 内容 |
| --- | --- |
| `app-state.json` | 店铺、商品、库存、规则、活动、事件和通知记录 |
| `monitor-config.json` | 后台轮询规则 |
| `monitor-state.json` | 库存变化基线 |
| `notification-config.json` | 网页配置的通知密钥和管理口令哈希 |

不要把 `data/` 提交到 Git。

## 部署到 Node.js

1. 安装依赖并创建配置。

```powershell
npm install
Copy-Item -LiteralPath .env.example -Destination .env
```

2. 在 `.env` 设置 `ADMIN_TOKEN` 和持久化路径。默认路径面向 Docker；直接运行 Node 时应改为当前用户可写且会被备份的目录。

```dotenv
APP_STATE_FILE=D:/stock-watch-data/app-state.json
MONITOR_CONFIG_FILE=D:/stock-watch-data/monitor-config.json
MONITOR_STATE_FILE=D:/stock-watch-data/monitor-state.json
NOTIFICATION_CONFIG_FILE=D:/stock-watch-data/notification-config.json
ADMIN_TOKEN=使用你自己的至少8位强口令
```

3. 启动服务。

```powershell
npm start
```

生产环境应使用 systemd、PM2 或平台自带的进程管理器，并限制数据目录权限。服务会自动读取项目根目录的 `.env`，但已有系统环境变量优先。

未预先设置 `ADMIN_TOKEN` 时，首次 GET 会返回示例状态；在页面“系统设置”输入至少 8 位口令并保存后，服务端会创建带盐哈希并开始保护状态读取。生产部署仍建议预先配置环境变量。

## 配置真实店铺

默认 `DEMO_MODE=true`，不会访问真实店铺。固定一个上游域名时使用：

```dotenv
DEMO_MODE=false
UPSTREAM_BASE_URL=https://shop.example.com
ALLOW_DYNAMIC_UPSTREAM=false
```

需要连接多个不同公网 HTTPS 域名时，可以设置 `ALLOW_DYNAMIC_UPSTREAM=true`。动态模式拒绝 localhost、`.local` 和直接 IP 地址，但仍会扩大服务端出站访问范围；公开部署优先使用固定上游。

当前适配器请求：

```text
POST /shopApi/Shop/info
POST /shopApi/Shop/categoryList
POST /shopApi/Shop/goodsList
```

不同店铺系统的路径或响应字段不一致时，需要同步修改 `worker.mjs` 和 `server.mjs`。只连接你有权访问的系统。

## 配置通知

| 渠道 | 配置项 |
| --- | --- |
| 飞书 | `FEISHU_WEBHOOK` |
| QQ | `QQ_WEBHOOK` |
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` |
| 钉钉 | `DINGTALK_WEBHOOK` |
| 企业微信 | `WECOM_WEBHOOK` |

Cloudflare 必须使用 Worker Secrets。Docker/Node 可以使用环境变量，也可以从网页配置；网页配置值只写入服务端的 `notification-config.json`，不会返回给前端。

## 升级部署

Cloudflare 每次拉取包含新 migration 的版本后，先执行：

```powershell
npx wrangler d1 migrations apply stock-watch-monitor --remote
npm run deploy
```

Docker/Node 升级前先备份数据目录，再替换代码和重启服务。旧版浏览器 `localStorage` 数据只会在服务端尚未初始化时读取一次；首次成功保存后会从浏览器删除。

## 排查问题

| 现象 | 检查 |
| --- | --- |
| `/api/app-state` 返回 401 | 页面口令是否与 `ADMIN_TOKEN` 或已创建的管理口令一致 |
| 保存返回 409 | 后台任务已更新状态；页面会重新加载服务端版本 |
| Cloudflare 提示未配置 D1 | `wrangler.toml` 是否存在 `binding = "DB"` |
| Cloudflare 提示迁移未完成 | 重新执行远程 migrations apply |
| Docker 重启后数据丢失 | `data:/data` 挂载是否存在且可写 |
| Node 无法写入状态 | 四个文件路径的父目录是否可创建、可写 |
| 商品接口失败 | 检查 `DEMO_MODE`、`UPSTREAM_BASE_URL`、动态上游设置和店铺 token |
| 后台任务不运行 | 检查 Worker Triggers 或 Node/Docker 日志 |

## 发布到 GitHub 前检查

```powershell
npm test
git status --short
git check-ignore .env data/ node_modules/ .wrangler/
```

确认 `.env`、`.dev.vars`、`data/`、`.wrangler/`、导出的配置和真实店铺信息没有进入提交。Cloudflare 发布前还应执行：

```powershell
npx wrangler deploy --dry-run
```
