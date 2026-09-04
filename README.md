# 货架雷达 · 店铺库存监控

一个可部署到 Cloudflare Worker 或 Docker 的库存监控台。仓库默认使用纯模拟数据，不访问任何真实店铺：

- 店铺：`https://demo.example.com/shop/DEMO001`
- 商品：`示例商品：云服务基础版`
- 初始库存：`0`

页面顶部会显示当前运行环境：Docker 容器显示“Docker 版”，Cloudflare Worker 显示“Worker 版”，直接运行服务端显示“Node 版”。

## 获取项目

```powershell
git clone https://github.com/YuZangA/stock-watch-monitor.git
Set-Location -LiteralPath '.\stock-watch-monitor'
```

## 本地运行

需要 Node.js。首次运行：

```powershell
npx wrangler dev
```

然后打开终端输出的本地地址。若希望仅查看静态页面，也可以直接打开 `index.html`，但直接打开时不能调用 `/api/stock`。

## Cloudflare Worker + D1 部署

```powershell
npx wrangler login
npx wrangler d1 create stock-watch-monitor
```

将创建命令输出的数据库 ID 写入 `wrangler.toml` 中已注释的 `[[d1_databases]]` 配置，再执行：

```powershell
npx wrangler d1 migrations apply stock-watch-monitor --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

`ADMIN_TOKEN` 是页面保存监控规则和发送测试通知时的管理口令；在网页“系统设置”输入后只保留在当前页面会话中。

Worker 的 Cron Trigger 每 5 分钟唤醒一次，并按网页保存的 5/10/15/30/60 分钟间隔从 D1 执行规则。D1 保存监控规则和库存基线，首次检查只建立基线；后续进入缺货或恢复库存时发送通知。

首次同步或监控规则发生变化后，Worker 会立即执行一次验证轮询。只有 D1 迁移可用、规则读取成功、库存接口返回且目标商品匹配成功时，才会通过已配置的通知渠道发送“Worker 已就绪”消息。相同配置不会重复发送；未配置通知 Secret 或没有重点监控规则时不会发送就绪通知。

`worker.mjs` 默认直接返回模拟库存。只有将 `DEMO_MODE=false` 并配置 `UPSTREAM_BASE_URL` 后，才会调用上游适配器：

- `/shopApi/Shop/info`
- `/shopApi/Shop/categoryList`
- `/shopApi/Shop/goodsList`

Docker 本地使用时也可在 `.env` 设置 `ALLOW_DYNAMIC_UPSTREAM=true`，让网页添加的公网 HTTPS 店铺使用其链接域名查询。Worker 公开部署建议关闭该选项并使用固定上游。

前端的店铺、排序、收藏和监控规则保存在浏览器 `localStorage`，Worker 部署时会额外把已启用的监控规则同步到 D1，导出按钮可以导出 JSON 配置。目前支持飞书、QQ Webhook、Telegram、钉钉和企业微信。

真实上游地址、代理凭据和通知密钥只能写入 `.env`、Cloudflare Secrets 或网页的服务端安全配置，禁止写入源代码和示例文件。

Docker 版可以直接在“通知渠道”页面点击“配置”填写密钥。首次保存时设置至少 8 位管理口令，服务端只保存口令的带盐哈希；Webhook 和 Token 写入 `/data/notification-config.json`，由 Docker 数据卷持久化，不会进入浏览器存储或配置导出文件。需要清除某个渠道时，在同一弹窗勾选“清空当前渠道配置”。

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中按需添加以下 Secrets：

- `FEISHU_WEBHOOK`
- `QQ_WEBHOOK`
- `TELEGRAM_BOT_TOKEN` 与 `TELEGRAM_CHAT_ID`
- `DINGTALK_WEBHOOK`
- `WECOM_WEBHOOK`

通知密钥必须使用 Secret，不要把密钥写入 `app.js`、提交到仓库或放进 `wrangler.toml`。Worker 仅允许所列静态资源路径，服务端源码和 `.env` 不会被公开提供。

代理地址字段已保留在系统设置中。Cloudflare Workers 原生出站请求不支持把任意用户输入直接作为传统 HTTP/SOCKS 代理，因此生产环境建议使用固定的代理出口或自建中转 Worker，并在函数内通过环境变量绑定。

Worker 版的 Cron 会在浏览器关闭后继续运行。Docker 版仍适合需要本地文件持久化、传统代理或不使用 Cloudflare 的场景。

如需保留旧的 Pages 演示部署，可使用 `npm run dev:pages` 或 `npm run deploy:pages`；该兼容路径没有 D1 后台监控能力。

## Docker 部署

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
docker compose up -d --build
docker compose logs -f
```

浏览器打开 `http://服务器IP:8788`。Docker 版会把网页中的店铺与重点监控规则自动保存到 `/data/monitor-config.json`；完成一次同步后，即使关闭网页，容器后台仍会继续轮询。首次检查只建立库存基线，之后库存进入缺货或从缺货恢复时才发送通知。

`MONITOR_ENABLED` 仅用于启用手动写在 `.env` 中的兼容规则；网页同步的规则无需打开该开关。

## 检查

```powershell
npm test
node --check app.js
node --check server.mjs
```

完整部署、真实上游适配和开源发布检查见 [部署与使用教程](docs/deployment.md)。

## 免责声明与项目地址

作者项目：[YuZangA/stock-watch-monitor.git](https://github.com/YuZangA/stock-watch-monitor.git)

本脚本来自 GitHub 仓库或由 AI 生成，仅供学习交流使用。

⚠️ 使用须知：

- 禁止用于商业用途，严禁产生利益链
- 请在下载后 24 小时内删除
- 请遵守相关法律法规，尊重目标平台服务条款

⚠️ 免责条款：

- 作者对脚本错误导致的任何损失概不负责
- 作者对隐私泄露或其他后果概不负责
- 间接使用者（如建立 VPS 传播）自行承担责任

如认为本脚本涉嫌侵权，请及时通知并提供身份证明，将在核实后删除。

若您不同意本声明，请立即停止使用并删除本脚本。
