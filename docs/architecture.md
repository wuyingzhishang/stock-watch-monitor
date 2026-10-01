# 架构说明

## 请求路径

浏览器只负责界面和短期偏好。业务状态由部署端保存：Cloudflare 使用 D1，Node/Docker 使用服务端 JSON 文件。库存请求通过 `/api/stock` 访问上游，后台任务使用相同的库存适配协议更新状态和通知。

## 运行模式

- `worker.mjs`：Cloudflare Worker、D1 和 Cron Trigger。
- `server.mjs`：Node/Docker HTTP 服务、文件存储和进程内定时器。
- `functions/api/*`：Cloudflare Pages 的静态演示接口，不提供后台监控。

## 数据边界

管理口令通过 `x-admin-token` 验证；通知密钥只保存在 Worker Secret、环境变量或服务端配置文件。动态上游默认关闭，仅允许 HTTPS，并拒绝 localhost、内网后缀和直接 IP。

## 一致性

状态写入携带 revision，旧页面提交会收到冲突响应。Worker 通过 D1 的 `last_run_at` 条件更新避免 Cron 重入，Node 通过进程内运行标记避免并发轮询。
