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
      NOTIFICATION_CONFIG_FILE: notificationConfigFile
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
});

test("serves the application shell", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /货架雷达/);
  assert.match(html, /state-store\.js/);

  const stateStoreResponse = await fetch(`${baseUrl}/state-store.js`);
  assert.equal(stateStoreResponse.status, 200);
  assert.match(await stateStoreResponse.text(), /migrateState/);
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
