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
    if (this.sql.startsWith("SELECT revision FROM app_config")) return this.database.appConfig ? { revision: this.database.appConfig.revision } : null;
    if (this.sql.startsWith("SELECT schema_version, revision")) return this.database.appConfig;
    if (this.sql.startsWith("SELECT interval_minutes, notify_recovery")) return this.database.appConfig;
    if (this.sql.startsWith("SELECT config_hash")) return this.database.config ? { config_hash: this.database.config.config_hash } : null;
    if (this.sql.startsWith("SELECT interval_minutes, updated_at")) return this.database.config;
    if (this.sql.startsWith("SELECT interval_minutes, ready_notified_at")) return this.database.config;
    if (this.sql.startsWith("SELECT COUNT(*)")) return { count: this.database.rules.size };
    if (this.sql.startsWith("SELECT stock")) return this.database.states.get(this.values[0]) || null;
    return null;
  }
  async all() {
    if (this.sql.startsWith("SELECT shop_id, name, custom_name")) return { results: [...this.database.shops.values()].sort((a, b) => a.sort_order - b.sort_order) };
    if (this.sql.startsWith("SELECT shop_id, product_key, name, category")) return { results: [...this.database.products.values()].sort((a, b) => a.sort_order - b.sort_order) };
    if (this.sql.startsWith("SELECT shop_id, icon, tone")) return { results: [...this.database.activity] };
    if (this.sql.startsWith("SELECT shop_id, product_key, product_name")) return { results: [...this.database.events] };
    if (this.sql.startsWith("SELECT shop_id, channel, message")) return { results: [...this.database.notifications] };
    if (this.sql.startsWith("SELECT rule_id")) return { results: [...this.database.rules.values()] };
    return { results: [] };
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO app_config")) {
      const [schema_version, revision, selected_shop_id, interval_minutes, keep_last_stock, notify_recovery, notify_only_monitored, updated_at] = this.values;
      this.database.appConfig = { schema_version, revision, selected_shop_id, interval_minutes, keep_last_stock, notify_recovery, notify_only_monitored, updated_at };
    } else if (this.sql === "DELETE FROM notification_log") {
      this.database.notifications = [];
    } else if (this.sql === "DELETE FROM inventory_events") {
      this.database.events = [];
    } else if (this.sql === "DELETE FROM activity") {
      this.database.activity = [];
    } else if (this.sql === "DELETE FROM products") {
      this.database.products.clear();
    } else if (this.sql === "DELETE FROM shops") {
      this.database.shops.clear();
    } else if (this.sql.startsWith("INSERT INTO shops")) {
      const [shop_id, name, custom_name, url, shop_token, note, enabled, favorite, remote_name, categories_json, sort_order, last_checked_at, created_at, updated_at] = this.values;
      this.database.shops.set(shop_id, { shop_id, name, custom_name, url, shop_token, note, enabled, favorite, remote_name, categories_json, sort_order, last_checked_at, created_at, updated_at });
    } else if (this.sql.startsWith("INSERT INTO products")) {
      const [shop_id, product_key, name, category, price, stock, monitored, favorite, sort_order, updated_at] = this.values;
      this.database.products.set(`${shop_id}:${product_key}`, { shop_id, product_key, name, category, price, stock, monitored, favorite, sort_order, updated_at });
    } else if (this.sql.startsWith("INSERT INTO activity")) {
      const [shop_id, icon, tone, title, meta, created_at] = this.values;
      this.database.activity.push({ shop_id, icon, tone, title, meta, created_at });
    } else if (this.sql.startsWith("INSERT INTO inventory_events")) {
      const [shop_id, product_key, product_name, message, tone, is_read, created_at] = this.values;
      this.database.events.push({ shop_id, product_key, product_name, message, tone, is_read, created_at });
    } else if (this.sql.startsWith("INSERT INTO notification_log")) {
      const [shop_id, channel, message, success, status_code, created_at] = this.values;
      this.database.notifications.push({ shop_id, channel, message, success, status_code, created_at });
    } else if (this.sql.startsWith("INSERT INTO monitor_config")) {
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
  constructor() {
    this.config = null;
    this.appConfig = null;
    this.rules = new Map();
    this.states = new Map();
    this.shops = new Map();
    this.products = new Map();
    this.activity = [];
    this.events = [];
    this.notifications = [];
  }
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

test("Worker returns the D1-backed default state before first save", async () => {
  const database = new FakeD1();
  const response = await worker.fetch(new Request("https://monitor.example/api/app-state", {
    headers: { "x-admin-token": "admin-secret" }
  }), { ASSETS: assets(), DB: database, ADMIN_TOKEN: "admin-secret" });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.initialized, false);
  assert.equal(payload.revision, 0);
  assert.equal(payload.state.schemaVersion, 4);
  assert.equal(payload.state.shops[0].id, "shop-demo001");
});

test("Worker saves all application state to D1 and rejects stale revisions", async () => {
  const database = new FakeD1();
  const env = { ASSETS: assets(), DB: database, ADMIN_TOKEN: "admin-secret", DEMO_MODE: "true" };
  const state = {
    schemaVersion: 4,
    shops: [{
      id: "shop-demo001",
      name: "我的演示店铺",
      customName: true,
      url: "https://demo.example.com/shop/DEMO001",
      token: "DEMO001",
      note: "D1 测试",
      enabled: true,
      favorite: true,
      lastChecked: 1_700_000_000_000,
      categories: ["订阅服务"],
      products: [{ id: "demo-pro", name: "示例商品", category: "订阅服务", price: 49.9, stock: 18, monitored: false, favorite: true }]
    }],
    selectedShopId: "shop-demo001",
    interval: 10,
    keepLastStock: true,
    notifyRecovery: true,
    notifyOnlyMonitored: true,
    activity: [{ shopId: "shop-demo001", icon: "!", tone: "red", title: "测试动态", meta: "D1", createdAt: "2026-08-04T00:00:00.000Z" }],
    events: [{ shopId: "shop-demo001", productKey: "demo-pro", product: "示例商品", text: "库存变化", tone: "green", read: false, createdAt: "2026-08-04T00:00:00.000Z" }],
    notificationLog: [{ shopId: "shop-demo001", channel: "telegram", text: "投递成功", success: true, statusCode: 200, createdAt: "2026-08-04T00:00:00.000Z" }]
  };
  const saveRequest = revision => new Request("https://monitor.example/api/app-state", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://monitor.example", "x-admin-token": "admin-secret" },
    body: JSON.stringify({ revision, state })
  });

  const saved = await worker.fetch(saveRequest(0), env, { waitUntil() {} });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const loaded = await worker.fetch(new Request("https://monitor.example/api/app-state", {
    headers: { "x-admin-token": "admin-secret" }
  }), env);
  const payload = await loaded.json();
  assert.equal(payload.initialized, true);
  assert.equal(payload.state.shops[0].name, "我的演示店铺");
  assert.equal(payload.state.shops[0].products[0].favorite, true);
  assert.equal(payload.state.events[0].text, "库存变化");
  assert.equal(payload.state.notificationLog[0].channel, "telegram");

  const stale = await worker.fetch(saveRequest(0), env, { waitUntil() {} });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).conflict, true);
});

test("Worker requires the admin secret for D1 application state reads and writes", async () => {
  const database = new FakeD1();
  const readResponse = await worker.fetch(
    new Request("https://monitor.example/api/app-state"),
    { ASSETS: assets(), DB: database, ADMIN_TOKEN: "admin-secret" }
  );
  assert.equal(readResponse.status, 401);

  const response = await worker.fetch(new Request("https://monitor.example/api/app-state", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://monitor.example" },
    body: JSON.stringify({ revision: 0, state: {} })
  }), { ASSETS: assets(), DB: database, ADMIN_TOKEN: "admin-secret" });
  assert.equal(response.status, 401);
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
