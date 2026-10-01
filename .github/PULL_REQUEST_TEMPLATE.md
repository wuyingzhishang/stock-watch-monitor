## 变更说明

<!-- 简述本次变更和动机。 -->

## 验证

- [ ] `npm test`
- [ ] `npm audit --omit=dev --audit-level=high`
- [ ] `npx --yes wrangler@latest deploy --dry-run`（涉及 Worker 时）

## 发布影响

- [ ] 不涉及数据库迁移
- [ ] 已说明 migration/回滚影响
- [ ] 未提交密钥、Webhook、真实店铺信息或 `data/`
