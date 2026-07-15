import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../functions/api/notify.js", import.meta.url), "utf8");
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("Cloudflare reports browser-only monitoring capabilities", async () => {
  const response = await api.onRequestGet({ env: {} });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deploymentMode, "cloudflare");
  assert.equal(payload.webConfigSupported, false);
  assert.equal(payload.backgroundMonitorSupported, false);
});
