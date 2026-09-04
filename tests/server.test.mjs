import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

const port = 18788;
const baseUrl = `http://127.0.0.1:${port}`;
let server;
const notificationConfigFile = resolve(tmpdir(), `stock-watch-notification-test-${process.pid}.json`);
const monitorConfigFile = resolve(tmpdir(), `stock-watch-monitor-config-test-${process.pid}.json`);
const monitorStateFile = resolve(tmpdir(), `stock-watch-monitor-state-test-${process.pid}.json`);
const appStateFile = resolve(tmpdir(), `stock-watch-app-state-test-${process.pid}.json`);

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MONITOR_ENABLED: "false",
      DEMO_MODE: "true",
      UPSTREAM_BASE_URL: "",
      ALLOW_DYNAMIC_UPSTREAM: "false",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      FEISHU_WEBHOOK: "",
      QQ_WEBHOOK: "",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      DINGTALK_WEBHOOK: "",
      WECOM_WEBHOOK: "",
      ADMIN_TOKEN: "",
      NOTIFICATION_CONFIG_FILE: notificationConfigFile,
      MONITOR_CONFIG_FILE: monitorConfigFile,
      MONITOR_STATE_FILE: monitorStateFile,
      APP_STATE_FILE: appStateFile
    },
    stdio: "ignore"
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("测试服务未能启动");
});

after(async () => {
  server?.kill();
  await unlink(notificationConfigFile).catch(() => {});
  await unlink(monitorConfigFile).catch(() => {});
  await unlink(monitorStateFile).catch(() => {});
  await unlink(appStateFile).catch(() => {});
});

test("serves the application shell", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /货架雷达/);
  assert.doesNotMatch(html, /state-store\.js/);
  assert.match(html, /app\.js\?v=13/);
  assert.match(html, /github\.com\/YuZangA\/stock-watch-monitor\.git/);

  const stateStoreResponse = await fetch(`${baseUrl}/state-store.js`);
  assert.equal(stateStoreResponse.status, 404);
});

test("does not expose environment or server files", async () => {
  for (const path of ["/.env", "/server.mjs", "/package.json", "/functions/api/notify.js"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
  }
});

test("reports notification configuration without exposing values", async () => {
  const response = await fetch(`${baseUrl}/api/notify`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    channels: { feishu: false, qq: false, telegram: false, dingtalk: false, wecom: false },
    webConfigSupported: true,
    backgroundMonitorSupported: true,
    setupRequired: true,
    deploymentMode: "node"
  });
});

test("returns deterministic demo inventory without external access", async () => {
  const response = await fetch(`${baseUrl}/api/stock?token=DEMO001`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.demo, true);
  assert.equal(payload.shop.name, "示例店铺");
  assert.equal(payload.products.length, 5);
  assert.deepEqual(payload.products.find(product => product.id === "demo-basic"), {
    id: "demo-basic",
    name: "示例商品：云服务基础版",
    category: "订阅服务",
    price: 19.9,
    stock: 0,
    monitored: false,
    favorite: false
  });
});

test("does not silently substitute demo data for an unapproved real shop", async () => {
  const shopUrl = encodeURIComponent("https://shop.example.com/shop/REAL001");
  const response = await fetch(`${baseUrl}/api/stock?token=REAL001&url=${shopUrl}`);
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /ALLOW_DYNAMIC_UPSTREAM/);
});

test("persists the complete application state on the Node server", async () => {
  const initial = await fetch(`${baseUrl}/api/app-state`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).initialized, false);

  const state = {
    schemaVersion: 4,
    shops: [{
      id: "shop-demo001",
      name: "Node 持久化店铺",
      customName: true,
      url: "https://demo.example.com/shop/DEMO001",
      token: "DEMO001",
      note: "server-state",
      enabled: true,
      favorite: true,
      lastChecked: 1_700_000_000_000,
      categories: ["订阅服务"],
      products: [{ id: "demo-basic", name: "示例商品：云服务基础版", category: "订阅服务", price: 19.9, stock: 9, monitored: false, favorite: true }]
    }],
    selectedShopId: "shop-demo001",
    interval: 5,
    keepLastStock: true,
    notifyRecovery: true,
    notifyOnlyMonitored: true,
    activity: [],
    events: [],
    notificationLog: []
  };
  const saveRequest = revision => fetch(`${baseUrl}/api/app-state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": "test-admin-token" },
    body: JSON.stringify({ revision, state })
  });
  const saved = await saveRequest(0);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);

  const anonymous = await fetch(`${baseUrl}/api/app-state`);
  assert.equal(anonymous.status, 401);
  const loaded = await fetch(`${baseUrl}/api/app-state`, { headers: { "x-admin-token": "test-admin-token" } });
  const payload = await loaded.json();
  assert.equal(payload.state.shops[0].name, "Node 持久化店铺");
  assert.equal(payload.state.shops[0].products[0].stock, 9);
  assert.equal(JSON.parse(await readFile(appStateFile, "utf8")).state.shops[0].token, "DEMO001");

  const stale = await saveRequest(0);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).conflict, true);
});

test("persists browser monitor rules without exposing their values", async () => {
  const crossOriginResponse = await fetch(`${baseUrl}/api/monitor-config`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://untrusted.example" },
    body: JSON.stringify({ interval: 5, rules: [] })
  });
  assert.equal(crossOriginResponse.status, 403);

  const response = await fetch(`${baseUrl}/api/monitor-config`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": "test-admin-token" },
    body: JSON.stringify({
      interval: 7,
      rules: [{
        id: "shop-demo001:demo-basic",
        shopId: "shop-demo001",
        shopName: "示例店铺",
        shopUrl: "https://demo.example.com/shop/DEMO001",
        token: "DEMO001",
        productKey: "demo-basic",
        productName: "示例商品：云服务基础版",
        notifyRecovery: true
      }]
    })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    saved: true,
    backgroundMonitorSupported: true,
    ruleCount: 1,
    interval: 7,
    updatedAt: payload.updatedAt
  });
  assert.equal(JSON.stringify(payload).includes("DEMO001"), false);

  const storedConfig = JSON.parse(await readFile(monitorConfigFile, "utf8"));
  assert.equal(storedConfig.rules.length, 1);
  assert.equal(storedConfig.rules[0].token, "DEMO001");

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const monitorState = JSON.parse(await readFile(monitorStateFile, "utf8"));
      if (monitorState.rules?.["shop-demo001:demo-basic"]?.stock === 0) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const monitorState = JSON.parse(await readFile(monitorStateFile, "utf8"));
  assert.equal(monitorState.rules["shop-demo001:demo-basic"].stock, 0);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const storedState = JSON.parse(await readFile(appStateFile, "utf8"));
    if (storedState.state.shops[0].products[0].stock === 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const backgroundState = JSON.parse(await readFile(appStateFile, "utf8"));
  assert.equal(backgroundState.state.shops[0].products[0].stock, 0);
  assert.equal(backgroundState.revision, 2);

  const statusResponse = await fetch(`${baseUrl}/api/monitor-config`);
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.equal(statusPayload.ruleCount, 1);
  assert.equal(JSON.stringify(statusPayload).includes("DEMO001"), false);
});

test("sets up protected web configuration without returning secrets", async () => {
  const response = await fetch(`${baseUrl}/api/notification-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "feishu",
      adminToken: "test-admin-token",
      setupAdmin: true,
      values: { FEISHU_WEBHOOK: "https://example.invalid/webhook-secret" }
    })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.channels.feishu, true);
  assert.equal(payload.setupRequired, false);
  assert.equal(JSON.stringify(payload).includes("webhook-secret"), false);
  const storedConfig = await readFile(notificationConfigFile, "utf8");
  assert.equal(storedConfig.includes("test-admin-token"), false);
  assert.match(storedConfig, /"hash":/);

  const wrongTokenResponse = await fetch(`${baseUrl}/api/notification-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "feishu", adminToken: "wrong-token", clear: true })
  });
  assert.equal(wrongTokenResponse.status, 401);

  const clearResponse = await fetch(`${baseUrl}/api/notification-config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "feishu", adminToken: "test-admin-token", clear: true })
  });
  assert.equal(clearResponse.status, 200);
  assert.equal((await clearResponse.json()).channels.feishu, false);
});
