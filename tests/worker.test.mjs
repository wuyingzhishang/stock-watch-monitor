import assert from "node:assert/strict";
import test from "node:test";

const module = await import(new URL("../worker.mjs", import.meta.url));
const worker = module.default;

function assets() {
  return { fetch: async request => new Response(`asset:${new URL(request.url).pathname}`) };
}

class FakeD1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new FakeD1Statement(this.database, this.sql, values); }
  async first() {
    if (this.sql.startsWith("SELECT config_hash")) return this.database.config ? { config_hash: this.database.config.config_hash } : null;
    if (this.sql.startsWith("SELECT interval_minutes, updated_at")) return this.database.config;
    if (this.sql.startsWith("SELECT interval_minutes, ready_notified_at")) return this.database.config;
    if (this.sql.startsWith("SELECT COUNT(*)")) return { count: this.database.rules.size };
    if (this.sql.startsWith("SELECT stock")) return this.database.states.get(this.values[0]) || null;
    return null;
  }
  async all() {
    if (this.sql.startsWith("SELECT rule_id")) return { results: [...this.database.rules.values()] };
    return { results: [] };
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO monitor_config")) {
      const [interval_minutes, updated_at, config_hash] = this.values;
      const prior = this.database.config;
      const unchanged = prior?.config_hash === config_hash;
      this.database.config = {
        interval_minutes,
        updated_at,
        config_hash,
        last_run_at: unchanged ? prior.last_run_at : null,
        last_success_at: prior?.last_success_at || null,
        last_success_count: prior?.last_success_count || 0,
        ready_notified_at: unchanged ? prior.ready_notified_at : null
      };
    } else if (this.sql === "DELETE FROM monitor_rules") {
      this.database.rules.clear();
    } else if (this.sql.startsWith("INSERT INTO monitor_rules")) {
      const [rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery] = this.values;
      this.database.rules.set(rule_id, { rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery });
    } else if (this.sql.startsWith("UPDATE monitor_config SET last_run_at")) {
      this.database.config.last_run_at = this.values[0];
    } else if (this.sql.startsWith("INSERT INTO monitor_state")) {
      const [rule_id, stock, updated_at] = this.values;
      this.database.states.set(rule_id, { stock, updated_at });
    } else if (this.sql.startsWith("UPDATE monitor_config SET last_success_at")) {
      this.database.config.last_success_at = this.values[0];
      this.database.config.last_success_count = this.values[1];
    } else if (this.sql.startsWith("UPDATE monitor_config SET ready_notified_at")) {
      this.database.config.ready_notified_at = this.values[0];
    }
    return { meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor() { this.config = null; this.rules = new Map(); this.states = new Map(); }
  prepare(sql) { return new FakeD1Statement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

test("Worker serves only whitelisted static assets and the demo stock API", async () => {
  const env = { ASSETS: assets(), DEMO_MODE: "true" };
  const shell = await worker.fetch(new Request("https://monitor.example/"), env);
  assert.equal(shell.status, 200);
  assert.equal(await shell.text(), "asset:/");

  const source = await worker.fetch(new Request("https://monitor.example/server.mjs"), env);
  assert.equal(source.status, 404);

  const stock = await worker.fetch(new Request("https://monitor.example/api/stock?token=DEMO001"), env);
  assert.equal(stock.status, 200);
  assert.equal((await stock.json()).products.length, 5);
});

test("Worker does not accept D1 rule updates without a configured database and admin secret", async () => {
  const request = new Request("https://monitor.example/api/monitor-config", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://monitor.example" },
    body: JSON.stringify({ interval: 5, rules: [] })
  });
  const response = await worker.fetch(request, { ASSETS: assets() });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /D1/);
});

test("Worker reports configured notification channels without revealing secrets", async () => {
  const response = await worker.fetch(new Request("https://monitor.example/api/notify"), {
    ASSETS: assets(),
    DB: {},
    FEISHU_WEBHOOK: "https://example.invalid/secret"
  });
  const payload = await response.json();
  assert.equal(payload.deploymentMode, "worker");
  assert.equal(payload.backgroundMonitorSupported, true);
  assert.equal(payload.channels.feishu, true);
  assert.equal(JSON.stringify(payload).includes("secret"), false);
});

test("Worker verifies changed D1 rules with a real inventory pass and does not queue unchanged rules again", async () => {
  const database = new FakeD1();
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const body = {
    interval: 5,
    rules: [{
      id: "shop-demo001:demo-basic",
      shopName: "示例店铺",
      shopUrl: "https://demo.example.com/shop/DEMO001",
      token: "DEMO001",
      productKey: "demo-basic",
      productName: "示例商品：云服务基础版",
      notifyRecovery: true
    }]
  };
  const createRequest = () => new Request("https://monitor.example/api/monitor-config", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://monitor.example", "x-admin-token": "admin-secret" },
    body: JSON.stringify(body)
  });
  const env = { ASSETS: assets(), DB: database, ADMIN_TOKEN: "admin-secret", DEMO_MODE: "true" };

  const firstResponse = await worker.fetch(createRequest(), env, context);
  const firstPayload = await firstResponse.json();
  assert.equal(firstPayload.migrationsApplied, true);
  assert.equal(firstPayload.configurationChanged, true);
  assert.equal(firstPayload.verificationQueued, true);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(database.config.last_success_count, 1);
  assert.ok(database.config.last_success_at);
  assert.equal(database.config.ready_notified_at, null, "没有通知 Secret 时不能记录已发送就绪通知");

  const secondPending = [];
  const secondResponse = await worker.fetch(createRequest(), env, { waitUntil(promise) { secondPending.push(promise); } });
  const secondPayload = await secondResponse.json();
  assert.equal(secondPayload.configurationChanged, false);
  assert.equal(secondPayload.verificationQueued, false);
  assert.equal(secondPending.length, 0);
});
