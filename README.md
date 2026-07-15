# 货架雷达 · 店铺库存监控

一个可部署到 Cloudflare Pages 或 Docker 的库存监控台。仓库默认使用纯模拟数据，不访问任何真实店铺：

- 店铺：`https://demo.example.com/shop/DEMO001`
- 商品：`示例商品：云服务基础版`
- 初始库存：`0`

页面顶部会显示当前运行环境：Docker 容器显示“Docker 版”，Cloudflare Pages 显示“Cloudflare 版”，直接运行服务端显示“Node 版”。

## 本地运行

需要 Node.js。首次运行：

```powershell
npx wrangler pages dev .
```

然后打开终端输出的本地地址。若希望仅查看静态页面，也可以直接打开 `index.html`，但直接打开时不能调用 `/api/stock`。

## Cloudflare Pages 部署

```powershell
npx wrangler login
npx wrangler pages deploy . --project-name stock-watch-monitor
```

`functions/api/stock.js` 默认直接返回模拟库存。只有将 `DEMO_MODE=false` 并配置 `UPSTREAM_BASE_URL` 后，才会调用上游适配器：

- `/shopApi/Shop/info`
- `/shopApi/Shop/categoryList`
- `/shopApi/Shop/goodsList`

Docker 本地使用时也可在 `.env` 设置 `ALLOW_DYNAMIC_UPSTREAM=true`，让网页添加的公网 HTTPS 店铺使用其链接域名查询。公开部署建议关闭该选项并使用固定上游。

前端的店铺、排序、收藏和监控规则保存在浏览器 `localStorage`，导出按钮可以导出 JSON 配置。目前支持飞书、QQ Webhook、Telegram、钉钉和企业微信。

真实上游地址、代理凭据和通知密钥只能写入 `.env`、Cloudflare Secrets 或网页的服务端安全配置，禁止写入源代码和示例文件。

Docker 版可以直接在“通知渠道”页面点击“配置”填写密钥。首次保存时设置至少 8 位管理口令，服务端只保存口令的带盐哈希；Webhook 和 Token 写入 `/data/notification-config.json`，由 Docker 数据卷持久化，不会进入浏览器存储或配置导出文件。需要清除某个渠道时，在同一弹窗勾选“清空当前渠道配置”。

在 Cloudflare Pages 项目设置的 **Settings → Variables and Secrets** 中按需添加：

- `FEISHU_WEBHOOK`
- `QQ_WEBHOOK`
- `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID`
- `DINGTALK_WEBHOOK`
- `WECOM_WEBHOOK`

Cloudflare Pages 无法像 Docker 一样持久化网页提交的配置，因此仍需使用项目 Secrets。不要把密钥写入 `app.js`、提交到仓库或放进 Pages 普通静态变量。`.assetsignore` 只允许部署三个前端静态文件，服务端源码和 `.env` 不会作为静态资源上传。

代理地址字段已保留在系统设置中。Cloudflare Workers 原生出站请求不支持把任意用户输入直接作为传统 HTTP/SOCKS 代理，因此生产环境建议使用固定的代理出口或自建中转 Worker，并在函数内通过环境变量绑定。

Cloudflare Pages 版的定时轮询由打开的浏览器页面执行；关闭页面后不会继续轮询。需要 7×24 小时后台监控时使用下方 Docker 版本，它包含独立后台轮询器和持久化状态文件。

## Docker 部署

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
docker compose up -d --build
docker compose logs -f
```

浏览器打开 `http://服务器IP:8788`。Docker 版包含独立 Node 服务端和容器内后台轮询器；即使网页关闭，`.env` 中的 `MONITOR_*` 规则仍会继续执行。

## 检查

```powershell
npm test
node --check app.js
node --check server.mjs
```

完整部署、真实上游适配和开源发布检查见 [部署与使用教程](docs/deployment.md)。
