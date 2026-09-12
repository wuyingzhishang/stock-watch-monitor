# 货架雷达：店铺库存监控

货架雷达是一个可以持续检查店铺商品库存，并在缺货或恢复库存时发送通知的监控面板。

同一套前端支持多种开源部署方式。Cloudflare Worker + D1 最省维护，Docker 和 Node 适合自托管：

| 部署方式 | 适合谁 | 关闭网页后继续监控 | 数据保存位置 |
| --- | --- | --- | --- |
| Cloudflare Worker + D1 | 无需自建服务器 | 支持 | Cloudflare D1 |
| Docker Compose | 已有 VPS、NAS 或容器平台 | 支持 | `/data/app-state.json` 挂载卷 |
| Node.js | 希望直接运行或自行接入进程管理器 | 支持 | `APP_STATE_FILE` 指定的服务端文件 |
| Cloudflare Pages | 仅展示界面和模拟数据 | 不支持 | 不保存业务数据 |

第一次使用建议先运行模拟数据，确认页面和通知正常后，再连接真实店铺。

## 开始前先了解三件事

1. **部署端是业务数据源。** Cloudflare 使用 D1，Docker/Node 使用服务端数据文件；店铺、商品、规则、库存、事件和通知记录不会以浏览器为准。
2. **前端不持久化业务数据。** 页面通过 `/api/app-state` 读取服务端状态；浏览器存储只允许用于不影响业务状态的界面偏好或短期缓存。
3. **关闭页面仍可监控。** Worker Cron 或 Node 后台任务负责拉取库存，通知密钥保存在 Worker Secrets、环境变量或 Docker 数据卷中。

项目默认使用模拟数据，不会访问任何真实店铺：

- 示例店铺：`https://demo.example.com/shop/DEMO001`
- 示例商品：`示例商品：云服务基础版`
- 示例库存：`0`

## 获取项目

需要 Node.js 20 或更高版本。首次使用时，在 PowerShell 中获取项目并进入项目目录：

```powershell
git clone git@github.com:wuyingzhishang/stock-watch-monitor.git
Set-Location -LiteralPath '.\stock-watch-monitor'
npm install
```

已经下载过项目时，不需要再次执行 `git clone`，直接进入现有项目目录即可。

选择一种部署方式继续。直接双击 `index.html` 只能查看静态界面，不能保存业务数据或执行后台监控。

## Cloudflare Worker + D1：推荐

### 一键自动部署

如果本机已经安装 Node.js 20+，可以让脚本自动完成 D1 创建/复用、绑定写入、远程迁移、Worker 发布和 `ADMIN_TOKEN` Secret 设置，不需要手动打开 Cloudflare 控制台创建数据库：

```powershell
npm install
npm run deploy:cloudflare:auto
```

脚本会优先使用已有的 Wrangler 登录状态；未登录时自动打开浏览器完成登录。也可以提前设置 `CLOUDFLARE_API_TOKEN` 使用无交互认证。首次未设置 `ADMIN_TOKEN` 时会自动生成管理口令并在终端显示一次，请立即保存。数据库名默认使用 `stock-watch-monitor`，可通过 `CLOUDFLARE_D1_NAME` 覆盖。

不需要购买域名或服务器。免费 Cloudflare 账号即可开始。

### 第 1 步：创建 D1 数据库

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)并登录。
2. 左侧进入 **Storage & Databases（存储和数据库）**。
3. 点击 **D1 SQL Database**。找不到时直接在控制台搜索 `D1`。
4. 点击 **Create database（创建数据库）**。
5. 数据库名称填写 `stock-watch-monitor`。
6. 创建完成后，复制数据库详情页中的 **Database ID**。

Database ID 类似下面这样，它不是密码：

```text
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

也可以使用命令创建。如果已经在网页创建过，不要重复执行：

```powershell
npx wrangler login
npx wrangler d1 create stock-watch-monitor
```

### 第 2 步：把 D1 绑定到 Worker（手动方式）

不使用一键脚本时，在项目根目录的 `wrangler.toml` 末尾添加 D1 配置，并填入刚才复制的 Database ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "stock-watch-monitor"
database_id = "填写你的 Database ID"
```

注意：

- `binding` 必须是 `DB`，项目代码通过这个名称访问数据库。
- 不要把管理口令、Webhook 或 Cloudflare API Token 写入该文件。
- Database ID 可以写在这里，账号密码和 API Token 不可以。

### 第 3 步：登录 Cloudflare

在项目目录运行：

```powershell
npx wrangler login
```

浏览器会打开 Cloudflare 授权页，点击 **Allow（允许）**，然后回到 PowerShell。

### 第 4 步：创建数据库表

项目的数据库结构位于 `migrations` 目录。执行：

```powershell
npx wrangler d1 migrations apply stock-watch-monitor --remote
```

出现确认提示时输入 `y`。必须保留 `--remote`，否则只会修改电脑上的本地测试数据库。

检查迁移是否成功：

```powershell
npx wrangler d1 migrations list stock-watch-monitor --remote
npx wrangler d1 execute stock-watch-monitor --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

正常情况下会看到以下业务表：

```text
monitor_config
monitor_rules
monitor_state
app_config
shops
products
activity
inventory_events
notification_log
```

### 第 5 步：发布 Worker

```powershell
npx wrangler deploy
```

部署成功后，终端会显示一个 `workers.dev` 地址，例如：

```text
https://stock-watch-monitor.你的账号.workers.dev
```

打开这个地址即可访问监控面板。页面顶部应显示“Worker 版”。

### 第 6 步：设置管理口令

`ADMIN_TOKEN` 用于从网页读取、保存 D1 业务数据和发送测试通知。它不是 Cloudflare 登录密码。

推荐使用命令创建 Secret：

```powershell
npx wrangler secret put ADMIN_TOKEN
```

按提示输入一个新的强口令。输入内容不会显示，这是正常现象。

也可以在 Cloudflare 后台设置：

1. 进入 **Workers & Pages**。
2. 打开 `stock-watch-monitor`。
3. 进入 **Settings → Variables and Secrets**。
4. 添加名称为 `ADMIN_TOKEN` 的变量。
5. 类型必须选择 **Secret（密钥）**，不要选择纯文本。

每次重新打开或刷新监控面板，都需要输入同一个管理口令解锁。网页只在当前页面内存中保留口令，不写入 Cookie 或浏览器存储；普通界面偏好和短期缓存不受此限制。

### 第 7 步：确认 D1 和定时任务

进入 Cloudflare 的 `stock-watch-monitor` Worker，检查：

- **Settings → Bindings** 中存在名为 `DB` 的 D1 绑定。
- **Triggers** 中存在 Cron：`*/5 * * * *`。
- **Deployments** 中最新部署状态为成功。

Cron 每 5 分钟唤醒一次 Worker。网页可以选择 5、10、15、30 或 60 分钟的实际检查间隔。

## 连接真实店铺

### 推荐：只允许一个固定域名

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中添加以下普通文本变量：

| 名称 | 值 | 类型 |
| --- | --- | --- |
| `DEMO_MODE` | `false` | 纯文本 |
| `UPSTREAM_BASE_URL` | `https://你的店铺域名` | 纯文本 |
| `ALLOW_DYNAMIC_UPSTREAM` | `false` | 纯文本 |

`UPSTREAM_BASE_URL` 只填写域名来源，不要带 `/shop/店铺编号`。

### 多个不同域名的店铺

确实需要让网页中添加的每个 HTTPS 店铺使用自己的域名时，设置：

| 名称 | 值 | 类型 |
| --- | --- | --- |
| `DEMO_MODE` | `false` | 纯文本 |
| `ALLOW_DYNAMIC_UPSTREAM` | `true` | 纯文本 |

变量名必须完全一致，尤其不要把 `DYNAMIC` 错写成 `DYNAMTC`。公开部署开启动态上游会扩大出站请求范围，固定域名方式更安全。

当前适配器会请求以下接口：

```text
POST /shopApi/Shop/info
POST /shopApi/Shop/categoryList
POST /shopApi/Shop/goodsList
```

上游响应需要使用项目当前支持的数据结构。如果目标店铺的接口路径或字段不同，需要修改 `worker.mjs` 中的适配逻辑。只连接你有权访问的系统。

## 为什么商品显示“0 件”

先确认：**部署 D1 不会自动产生商品数据**。商品列表为空通常与 `/api/stock` 请求有关。

按下面顺序检查：

1. 店铺链接必须是 HTTPS，并符合 `https://域名/shop/店铺编号` 的格式。
2. `DEMO_MODE` 应为 `false`。
3. 使用动态店铺域名时，确认变量名精确为 `ALLOW_DYNAMIC_UPSTREAM`，值为 `true`。
4. 使用固定域名时，确认 `UPSTREAM_BASE_URL` 只包含正确的协议和域名。
5. 修改变量后确认 Cloudflare 已生成新的成功部署。

如果仍然没有商品：

1. 在监控网页按 `F12`。
2. 打开 **Network（网络）**。
3. 刷新店铺并找到 `api/stock` 请求。
4. 查看 **Response（响应）** 中的 `error` 和 `detail`。

也可以在 Cloudflare Worker 的 **Logs** 中打开实时日志，再刷新一次店铺。常见原因包括：

- 店铺接口路径与当前适配器不同。
- 店铺接口返回结构中没有 `data.list`。
- 店铺服务器拒绝 Cloudflare 的请求。
- 店铺 token 不正确或包含当前代码不允许的字符。

界面中的绿点仅表示店铺已启用，不等于商品接口请求成功。同步失败时应以页面提示、Network 响应和 Worker 日志为准。

## Cloudflare D1 中保存什么

- `app_config`：轮询周期、通知策略、选中店铺和云端修订号。
- `shops` / `products`：店铺、商品、排序、收藏、库存和重点监控状态。
- `activity` / `inventory_events`：最近动态和库存变化历史。
- `notification_log`：通知渠道、投递结果和 HTTP 状态。
- `monitor_*`：Cron 运行健康、规则兼容数据和库存基线。

旧版页面如果在 `localStorage` 中存在数据，新版会只读取一次。在“系统设置”输入管理口令并保存后，数据会写入当前部署端，原有浏览器业务数据会被删除。

第一次后台检查只建立库存基线，不立即发送缺货通知。之后库存从非零变为 0，或者启用恢复通知后库存从 0 恢复，才会发送通知。

首次同步或规则变化后，Worker 会执行验证轮询。只有数据库迁移、规则保存、库存请求和商品匹配都成功，才会通过已配置的通知渠道发送一次“Worker 已就绪”消息。

项目升级后如果新增了 migration，需要再次执行：

```powershell
npx wrangler d1 migrations apply stock-watch-monitor --remote
```

## Docker 或 Node 部署

Docker Compose：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
docker compose up -d --build
docker compose logs -f
```

浏览器访问 `http://服务器地址:8788`。`docker-compose.yml` 将 `/data` 映射到仓库的 `data/`，完整业务状态保存在 `data/app-state.json`。

直接运行 Node.js：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
npm install
npm start
```

Node 运行需要 Node.js 20 或更高版本。生产环境应设置 `APP_STATE_FILE`、`MONITOR_CONFIG_FILE`、`MONITOR_STATE_FILE` 和 `NOTIFICATION_CONFIG_FILE` 到可持久化目录，并使用进程管理器保证服务重启。

首次未配置 `ADMIN_TOKEN` 时，可以在页面“系统设置”中输入至少 8 位管理口令并保存，服务端只保存带盐哈希。也可以直接在 `.env` 配置 `ADMIN_TOKEN`。

## 通知渠道

所有服务端部署支持以下配置项：

- `FEISHU_WEBHOOK`
- `QQ_WEBHOOK`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DINGTALK_WEBHOOK`
- `WECOM_WEBHOOK`

Cloudflare 中使用 Worker Secrets；Docker/Node 可以使用 `.env`，也可以在网页中安全配置。不要把真实值写入 `app.js`、`wrangler.toml`、README 或截图。

## 常用命令

```powershell
# Node 服务
npm start

# Docker 服务
npm run start:docker

# Worker 开发
npm run dev

# 部署 Cloudflare Worker
npm run deploy

# 运行测试
npm test
```

Cloudflare Pages 脚本保留用于静态演示。Pages 不提供 `/api/app-state` 持久化和后台轮询，不应作为正式监控部署。

更多配置和真实上游说明见 [部署与使用教程](docs/deployment.md)。

## 安全提醒

- 不要在截图、聊天、日志或代码中公开 `ADMIN_TOKEN`、Webhook、Bot Token 或 Cloudflare API Token。
- 如果口令已经出现在截图中，请立即删除旧值并创建新的 Secret。
- 生产环境优先使用固定 `UPSTREAM_BASE_URL`，不要无必要开启动态上游。
- 上传代码前检查 `.env`、`.dev.vars`、`data` 和 `.wrangler` 没有进入 Git。

## 免责声明与项目地址

作者项目：[wuyingzhishang/stock-watch-monitor](https://github.com/wuyingzhishang/stock-watch-monitor)

本项目仅供学习交流使用。请遵守相关法律法规和目标平台服务条款，只连接你有权访问的接口。

- 禁止用于商业用途或形成利益链。
- 请在下载后 24 小时内删除。
- 使用者自行承担因配置错误、数据丢失、隐私泄露或其他问题造成的风险。
- 如认为本项目涉嫌侵权，请联系作者并提供必要证明。

不同意以上声明时，请停止使用并删除本项目。
