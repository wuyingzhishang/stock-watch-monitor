# 运维手册

## 健康检查

Node/Docker 部署使用 `GET /healthz`。正常响应为 HTTP 200；后台监控最近一次执行失败时返回 HTTP 503，并包含最近启动、完成、成功时间、规则数量和错误摘要。

Cloudflare 部署使用 `GET /api/monitor-config` 查看 D1 中的监控状态，重点关注 `lastRunAt`、`lastSuccessAt` 和 `lastSuccessCount`。Cron 每 5 分钟触发一次，实际执行间隔由配置决定。

## 发布前检查

```powershell
npm ci
npm test
npm audit --omit=dev --audit-level=high
npx --yes wrangler@latest deploy --dry-run
```

## 回滚

1. 保留当前版本的 Git commit、Worker deployment ID 和 `data/` 或 D1 备份。
2. Node/Docker：停止服务，恢复上一版本代码，确认数据目录未被覆盖后重新启动。
3. Cloudflare：使用上一版本 commit 重新运行手动部署工作流；先应用已存在的迁移，不要删除 D1 数据库。
4. 如果迁移导致不兼容，优先发布兼容旧字段的代码，再处理数据修复，避免直接回滚数据库结构。

## 数据备份

Node/Docker 备份 `APP_STATE_FILE`、`MONITOR_CONFIG_FILE`、`MONITOR_STATE_FILE` 和 `NOTIFICATION_CONFIG_FILE`。Cloudflare D1 应在重大升级前导出关键表，并单独保存 Worker Secrets，不要写入 Git。

## 常见告警

| 告警 | 处理 |
| --- | --- |
| `/healthz` 返回 503 | 查看服务日志中的后台监控错误，检查上游地址、代理和店铺 token |
| `lastRunAt` 更新但 `lastSuccessAt` 不更新 | 检查 D1 迁移、上游响应和 Cron 日志 |
| 通知持续失败 | 检查 Webhook/Telegram 凭据、429 限流和 `NOTIFICATION_RETRIES` |
