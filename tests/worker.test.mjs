import assert from "node:assert/strict";
import test from "node:test";

const module = await import(new URL("../worker.mjs", import.meta.url));
const worker = module.default;

function assets() {
  return { fetch: async request => new Response(`asset:${new URL(request.url).pathname}`) };
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
