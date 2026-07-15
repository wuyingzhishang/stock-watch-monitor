# 店铺库存监控部署与使用教程

本项目默认运行在模拟模式，不访问任何真实店铺。首次启动会展示：

- 示例店铺：`https://demo.example.com/shop/DEMO001`
- 示例重点商品：`示例商品：云服务基础版`
- 示例库存：`0`

## 方案选择

| 方案 | 适用场景 | 网页关闭后轮询 | 通知配置 |
| --- | --- | --- | --- |
| Docker | VPS、NAS、Docker Desktop | 支持 | 可在网页填写 |
| Cloudflare Pages | 无服务器静态控制台 | 不支持 | 使用项目 Secrets |

需要 7×24 小时监控时使用 Docker。

## Docker 部署

### 1. 获取项目

```powershell
git clone https://github.com/YuZangA/stock-watch-monitor.git
Set-Location -LiteralPath '.\stock-watch-monitor'
```

### 2. 准备配置

在项目目录执行：

```powershell
Copy-Item -LiteralPath '.env.example' -Destination '.env'
```

开源演示配置：

```dotenv
DEMO_MODE=true
UPSTREAM_BASE_URL=
ALLOW_DYNAMIC_UPSTREAM=false
MONITOR_ENABLED=false
MONITOR_TOKEN=DEMO001
MONITOR_PRODUCT_KEY=demo-basic
MONITOR_PRODUCT_NAME=示例商品：云服务基础版
```

`.env` 已被 Git 忽略，不要提交或分享。

### 3. 启动

```powershell
docker compose up -d --build
docker compose ps
docker compose logs --tail 100
```

打开 <http://127.0.0.1:8788>。页面顶部应显示“Docker 版”。

健康检查：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8788/healthz'
Invoke-RestMethod 'http://127.0.0.1:8788/api/stock?token=DEMO001'
```

### 4. 停止和更新

```powershell
docker compose down
docker compose up -d --build
```

## 模拟模式与真实上游

默认配置不会发起外部库存请求：

```dotenv
DEMO_MODE=true
UPSTREAM_BASE_URL=
```

接入自有或已获授权的接口时：

```dotenv
DEMO_MODE=false
UPSTREAM_BASE_URL=https://api.example.com
```

如需让用户在网页中添加不同公网 HTTPS 店铺，并直接使用店铺链接的域名作为上游：

```dotenv
ALLOW_DYNAMIC_UPSTREAM=true
```

动态上游会拒绝 localhost、`.local` 和直接 IP 地址。公开部署时建议保持关闭，改用固定的 `UPSTREAM_BASE_URL`。

当前适配器使用以下相对路径：

- `/shopApi/Shop/info`
- `/shopApi/Shop/categoryList`
- `/shopApi/Shop/goodsList`

不同系统的字段或路径不一致时，请在 `server.mjs` 和 `functions/api/stock.js` 中调整适配逻辑。只接入你有权访问的接口。

## Docker 后台监控

Docker 页面会自动把启用的店铺、重点监控商品和轮询间隔同步到 `/data/monitor-config.json`。同步成功后关闭页面，容器仍会继续检查库存。删除店铺或关闭重点监控时，后台规则也会随之删除。

`MONITOR_ENABLED` 只用于启用手动写在 `.env` 中的兼容规则；网页同步规则不依赖此开关。需要额外添加环境变量规则时使用：

```dotenv
MONITOR_ENABLED=true
MONITOR_INTERVAL_MINUTES=5
MONITOR_TOKEN=DEMO001
MONITOR_PRODUCT_KEY=demo-basic
MONITOR_PRODUCT_NAME=示例商品：云服务基础版
MONITOR_STATE_FILE=/data/monitor-state.json
MONITOR_CONFIG_FILE=/data/monitor-config.json
```

多条规则使用一行 JSON：

```dotenv
MONITOR_RULES_JSON=[{"token":"DEMO001","productKey":"demo-basic","productName":"示例商品：云服务基础版"},{"token":"DEMO002","productKey":"demo-pro","productName":"示例商品：云服务专业版"}]
```

后台首次检查只建立库存基线，不立即通知。之后库存从非零变为 0，或在启用恢复通知时从 0 恢复，才会发送消息。Docker 模式下库存事件由后台统一投递，避免页面轮询与后台重复通知。

## 通知渠道

Docker 版进入“通知渠道”，点击“配置”即可填写飞书、QQ、Telegram、钉钉或企业微信。首次保存需设置至少 8 位管理口令。

配置文件保存在 `/data/notification-config.json`：

- Webhook 和 Token 不进入浏览器 `localStorage`。
- 管理口令只保存带盐哈希。
- `data/` 已被 Git 忽略。

Cloudflare Pages 版需在项目的 Variables and Secrets 中按需添加：

- `FEISHU_WEBHOOK`
- `QQ_WEBHOOK`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DINGTALK_WEBHOOK`
- `WECOM_WEBHOOK`

不要将真实值写入代码或 `.env.example`。

## 代理

服务端代理配置：

```dotenv
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
ALLOW_CLIENT_PROXY=false
```

生产环境建议保持 `ALLOW_CLIENT_PROXY=false`。当前 Docker 服务仅支持 HTTP/HTTPS 代理。

## Cloudflare Pages

```powershell
npx wrangler login
npx wrangler pages deploy . --project-name stock-watch-monitor
```

在 Cloudflare 项目变量中保持模拟模式：

```text
DEMO_MODE=true
```

如需接入自有上游，将 `DEMO_MODE` 设为 `false`，并把 `UPSTREAM_BASE_URL` 作为变量配置。页面顶部会显示“Cloudflare 版”。

## 页面使用

- “添加店铺”支持形如 `https://demo.example.com/shop/DEMO001` 的链接。
- 商品可按分类、名称和库存筛选。
- 商品和店铺支持收藏、排序和重点监控。
- 删除店铺会取消未完成的页面请求，并清理关联动态、事件和通知记录。
- 页面配置存放在当前浏览器，上传仓库前不需要导出浏览器数据。

## 开源发布检查

发布前执行：

```powershell
rg -n --hidden --no-ignore -g '!node_modules/**' -g '!.wrangler/**' 'password|secret|token|webhook|api[_-]?key' .
git status --short
git check-ignore .env data/ node_modules/ .wrangler/
```

人工检查并确认：

- `.env`、`.dev.vars`、`data/`、`.wrangler/`、`node_modules/` 未提交。
- 文档只包含 `example.com`、`DEMO001` 等模拟值。
- 截图、日志和导出的 JSON 不包含真实店铺、账号或通知地址。

## 常见问题

- 页面显示“静态预览”：当前没有可用的服务端 API。
- 店铺接口不可用：检查 `DEMO_MODE`、`UPSTREAM_BASE_URL`、DNS 和代理。
- 网页关闭后不轮询：使用 Docker 并开启 `MONITOR_ENABLED`。
- 删除店铺后仍看到旧动态：刷新页面以加载最新前端资源。
