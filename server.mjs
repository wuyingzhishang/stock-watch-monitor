import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { fetch, ProxyAgent } from "undici";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));

try {
  const contents = await readFile(resolve(root, ".env"), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error?.code !== "ENOENT") console.warn(`无法读取 .env：${error.message}`);
}

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "0.0.0.0";
const upstream = String(process.env.UPSTREAM_BASE_URL || "").replace(/\/+$/, "");
const demoMode = process.env.DEMO_MODE !== "false";
const allowDynamicUpstream = process.env.ALLOW_DYNAMIC_UPSTREAM === "true";
const defaultProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const defaultDispatcher = createDispatcher(defaultProxy);
const configuredUpstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const upstreamTimeoutMs = Number.isFinite(configuredUpstreamTimeoutMs) ? Math.max(1000, configuredUpstreamTimeoutMs) : 15000;
const monitorStateFile = process.env.MONITOR_STATE_FILE || "/data/monitor-state.json";
const monitorConfigFile = process.env.MONITOR_CONFIG_FILE || "/data/monitor-config.json";
const notificationConfigFile = process.env.NOTIFICATION_CONFIG_FILE || "/data/notification-config.json";
const appStateFile = process.env.APP_STATE_FILE || "/data/app-state.json";
const publicFiles = new Set(["index.html", "styles.css", "app.js"]);
const notificationFields = {
  feishu: ["FEISHU_WEBHOOK"],
  qq: ["QQ_WEBHOOK"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  dingtalk: ["DINGTALK_WEBHOOK"],
  wecom: ["WECOM_WEBHOOK"]
};
let backgroundMonitorTimer;
let backgroundMonitorRunning = false;
let appStateWriteQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function createDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const url = new URL(proxyUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("仅支持 HTTP/HTTPS 代理");
    return new ProxyAgent(proxyUrl);
  } catch (error) {
    console.warn(`忽略无效代理配置：${error.message}`);
    return undefined;
  }
}

function dispatcherFor(request) {
  if (process.env.ALLOW_CLIENT_PROXY !== "true") return defaultDispatcher;
  return createDispatcher(request.headers["x-proxy-url"] || "") || defaultDispatcher;
}

function requestIsSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-proxy-url, x-admin-token" });
  response.end(JSON.stringify(data));
}

async function readNotificationConfig() {
  try {
    const config = JSON.parse(await readFile(notificationConfigFile, "utf8"));
    return { admin: config.admin || null, channels: config.channels || {} };
  } catch { return { admin: null, channels: {} }; }
}

async function writeNotificationConfig(config) {
  await mkdir(resolve(notificationConfigFile, ".."), { recursive: true });
  await writeFile(notificationConfigFile, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}

function tokenHash(token, salt) {
  return scryptSync(String(token), salt, 32);
}

function tokensMatch(left, right) {
  const leftHash = tokenHash(left, "stock-watch-admin");
  const rightHash = tokenHash(right, "stock-watch-admin");
  return timingSafeEqual(leftHash, rightHash);
}

function isAdminConfigured(config) {
  return Boolean(process.env.ADMIN_TOKEN || (config.admin?.salt && config.admin?.hash));
}

function authenticateAdmin(token, config) {
  if (!token) return false;
  if (process.env.ADMIN_TOKEN) return tokensMatch(token, process.env.ADMIN_TOKEN);
  if (!config.admin?.salt || !config.admin?.hash) return false;
  const actual = tokenHash(token, config.admin.salt);
  const expected = Buffer.from(config.admin.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function notificationSettings(config) {
  const settings = {};
  for (const fields of Object.values(notificationFields)) {
    for (const field of fields) settings[field] = Object.hasOwn(config.channels, field) ? String(config.channels[field] || "") : (process.env[field] || "");
  }
  return settings;
}

function validWebhook(value) {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
}

async function readJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function demoStockData(token = "DEMO001") {
  return {
    fetchedAt: Date.now(),
    demo: true,
    shop: { name: "示例店铺", token, link: `https://demo.example.com/shop/${token}`, description: "开源演示数据，不对应任何真实店铺" },
    categories: ["订阅服务", "增值服务", "数字商品"],
    products: [
      { id: "demo-basic", name: "示例商品：云服务基础版", category: "订阅服务", price: 19.9, stock: 0, monitored: false, favorite: false },
      { id: "demo-pro", name: "示例商品：云服务专业版", category: "订阅服务", price: 49.9, stock: 18, monitored: false, favorite: false },
      { id: "demo-storage", name: "示例商品：存储扩展包", category: "增值服务", price: 9.9, stock: 4, monitored: false, favorite: false },
      { id: "demo-support", name: "示例商品：技术支持服务", category: "增值服务", price: 29.9, stock: 32, monitored: false, favorite: false },
      { id: "demo-license", name: "示例商品：团队授权许可", category: "数字商品", price: 99, stock: 7, monitored: false, favorite: false }
    ]
  };
}

function stockSource(shopUrl, token) {
  if (!shopUrl) {
    if (demoMode) return { demo: true, upstream: "" };
    if (upstream) return { demo: false, upstream };
    throw new Error("未配置库存上游地址");
  }
  const parsed = new URL(shopUrl);
  const tokenMatch = parsed.pathname.match(/^\/shop\/([A-Za-z0-9]+)\/?$/i);
  if (parsed.protocol !== "https:" || !tokenMatch || tokenMatch[1] !== token) throw new Error("店铺链接必须是包含相同 token 的 HTTPS 地址");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "demo.example.com") return { demo: true, upstream: "" };
  if (hostname === "localhost" || hostname.endsWith(".local") || isIP(hostname)) throw new Error("不允许使用本地或 IP 地址作为动态上游");
  if (allowDynamicUpstream) return { demo: false, upstream: parsed.origin };
  if (!demoMode && upstream) return { demo: false, upstream };
  throw new Error("当前仅启用模拟数据；真实店铺需开启 ALLOW_DYNAMIC_UPSTREAM");
}

async function postJson(baseUrl, path, payload, dispatcher) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0 (compatible; StockWatchMonitor/0.1)", referer: `${baseUrl}/` },
    body: JSON.stringify(payload),
    dispatcher,
    signal: AbortSignal.timeout(upstreamTimeoutMs)
  });
  if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
  const data = await response.json();
  if (data.code !== 1) throw new Error(data.msg || "上游接口错误");
  return data.data;
}

async function fetchStockData(token, dispatcher, source = { demo: demoMode || !upstream, upstream }) {
  if (source.demo) return demoStockData(token);
  const [shop, categories] = await Promise.all([
    postJson(source.upstream, "/shopApi/Shop/info", { token }, dispatcher),
    postJson(source.upstream, "/shopApi/Shop/categoryList", { token, goods_type: "card" }, dispatcher)
  ]);
  const pages = [];
  const pageSize = 50;
  for (let current = 1; current <= 20; current += 1) {
    const page = await postJson(source.upstream, "/shopApi/Shop/goodsList", { token, goods_type: "card", current, pageSize, category_id: 0, keywords: "" }, dispatcher);
    pages.push(page);
    if (!Array.isArray(page?.list) || page.list.length < pageSize) break;
  }
  const products = pages.flatMap(page => page?.list || []).map(item => ({ id: item.goods_key, name: item.name, category: item.category?.name || "未分类", price: Number(item.price || 0), stock: Number(item.extend?.stock_count || 0), monitored: false, favorite: false }));
  return { fetchedAt: Date.now(), shop: { name: shop.nickname, token: shop.token, link: shop.link, description: shop.description }, categories: (categories || []).map(item => item.name), products };
}

function defaultAppState() {
  const demo = demoStockData();
  return {
    schemaVersion: 4,
    shops: [{
      id: "shop-demo001",
      name: demo.shop.name,
      customName: true,
      url: demo.shop.link,
      token: demo.shop.token,
      note: "开源演示数据",
      enabled: true,
      favorite: true,
      lastChecked: Date.now(),
      categories: demo.categories,
      products: demo.products.map(product => ({ ...product, monitored: product.id === "demo-basic", favorite: ["demo-basic", "demo-license"].includes(product.id) }))
    }],
    selectedShopId: "shop-demo001",
    interval: 5,
    keepLastStock: true,
    notifyRecovery: true,
    notifyOnlyMonitored: true,
    activity: [{ icon: "!", tone: "red", title: "示例商品：云服务基础版 库存为 0", meta: "示例店铺 · 当前状态", shopId: "shop-demo001", createdAt: new Date().toISOString() }],
    events: [],
    notificationLog: []
  };
}

function cleanText(value, maxLength, fallback = "") {
  const result = String(value ?? "").trim().slice(0, maxLength);
  return result || fallback;
}

function normalizeAppState(input) {
  if (!input || typeof input !== "object") throw new Error("应用状态格式无效");
  if (!Array.isArray(input.shops) || input.shops.length > 50) throw new Error("店铺数据无效或超过 50 个");
  let productCount = 0;
  const shops = input.shops.map((shop, shopIndex) => {
    const products = Array.isArray(shop.products) ? shop.products : [];
    productCount += products.length;
    if (productCount > 2000) throw new Error("商品总数不能超过 2000 个");
    const id = cleanText(shop.id, 120, `shop-${shopIndex + 1}`);
    return {
      id,
      name: cleanText(shop.name, 300, `店铺 ${shopIndex + 1}`),
      customName: Boolean(shop.customName),
      url: cleanText(shop.url, 2048),
      token: cleanText(shop.token, 300),
      note: cleanText(shop.note, 1000),
      enabled: shop.enabled !== false,
      favorite: Boolean(shop.favorite),
      remoteName: cleanText(shop.remoteName, 300) || null,
      lastChecked: Number.isFinite(Number(shop.lastChecked)) ? Number(shop.lastChecked) : null,
      categories: Array.isArray(shop.categories) ? shop.categories.map(category => cleanText(category, 200)).filter(Boolean).slice(0, 200) : [],
      products: products.map((product, productIndex) => ({
        id: cleanText(product.id, 300, `product-${productIndex + 1}`),
        name: cleanText(product.name, 500, `商品 ${productIndex + 1}`),
        category: cleanText(product.category, 200, "未分类"),
        price: Number.isFinite(Number(product.price)) ? Number(product.price) : 0,
        stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0,
        monitored: Boolean(product.monitored),
        favorite: Boolean(product.favorite)
      }))
    };
  });
  const shopIds = new Set(shops.map(shop => shop.id));
  const timeline = (items, mapper) => (Array.isArray(items) ? items : []).slice(0, 100).map(mapper);
  return {
    schemaVersion: 4,
    shops,
    selectedShopId: shopIds.has(input.selectedShopId) ? input.selectedShopId : (shops[0]?.id || null),
    interval: normalizeMonitorInterval(input.interval),
    keepLastStock: input.keepLastStock !== false,
    notifyRecovery: input.notifyRecovery !== false,
    notifyOnlyMonitored: input.notifyOnlyMonitored !== false,
    activity: timeline(input.activity, item => ({ shopId: cleanText(item.shopId, 120) || null, icon: cleanText(item.icon, 20), tone: cleanText(item.tone, 20), title: cleanText(item.title, 500), meta: cleanText(item.meta, 1000), createdAt: cleanText(item.createdAt, 60, new Date().toISOString()) })),
    events: timeline(input.events, item => ({ shopId: cleanText(item.shopId, 120) || null, productKey: cleanText(item.productKey, 300) || null, product: cleanText(item.product, 500), text: cleanText(item.text, 1000), tone: cleanText(item.tone, 20, "red"), read: Boolean(item.read), createdAt: cleanText(item.createdAt, 60, new Date().toISOString()) })),
    notificationLog: timeline(input.notificationLog, item => ({ shopId: cleanText(item.shopId, 120) || null, channel: cleanText(item.channel, 50), text: cleanText(item.text, 1000), success: Boolean(item.success), statusCode: Number.isFinite(Number(item.statusCode)) ? Number(item.statusCode) : null, createdAt: cleanText(item.createdAt, 60, new Date().toISOString()) }))
  };
}

async function readAppStateRecord() {
  try {
    const record = JSON.parse(await readFile(appStateFile, "utf8"));
    return { initialized: true, revision: Number(record.revision || 0), updatedAt: record.updatedAt || null, state: normalizeAppState(record.state) };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`应用状态文件无效：${error.message}`);
    return { initialized: false, revision: 0, updatedAt: null, state: defaultAppState() };
  }
}

async function writeAppStateRecord(record) {
  await mkdir(resolve(appStateFile, ".."), { recursive: true });
  const temporaryFile = `${appStateFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, appStateFile);
}

function withAppStateLock(task) {
  const result = appStateWriteQueue.then(task, task);
  appStateWriteQueue = result.catch(() => {});
  return result;
}

async function appStateAuthorization(request, { allowSetup = false, allowUnconfigured = false } = {}) {
  const config = await readNotificationConfig();
  const token = String(request.headers["x-admin-token"] || "");
  if (isAdminConfigured(config)) return authenticateAdmin(token, config) ? { ok: true, config } : { ok: false, status: 401, error: "管理口令无效" };
  if (allowSetup) {
    if (token.length < 8) return { ok: false, status: 400, error: "请设置至少 8 位管理口令" };
    const salt = randomBytes(16).toString("hex");
    config.admin = { salt, hash: tokenHash(token, salt).toString("hex") };
    await writeNotificationConfig(config);
    return { ok: true, config };
  }
  return allowUnconfigured ? { ok: true, config } : { ok: false, status: 503, error: "尚未设置管理口令" };
}

async function handleAppStateRead(request, response) {
  const authorization = await appStateAuthorization(request, { allowUnconfigured: true });
  if (!authorization.ok) return sendJson(response, { error: authorization.error }, authorization.status);
  try { return sendJson(response, await readAppStateRecord()); }
  catch (error) { return sendJson(response, { error: error.message || "服务端状态读取失败" }, 500); }
}

async function handleAppStateSave(request, response) {
  if (!requestIsSameOrigin(request)) return sendJson(response, { error: "仅允许同源页面保存数据" }, 403);
  try {
    const body = await readJson(request, 2 * 1024 * 1024);
    const result = await withAppStateLock(async () => {
      const authorization = await appStateAuthorization(request, { allowSetup: true });
      if (!authorization.ok) return { status: authorization.status, payload: { error: authorization.error } };
      const current = await readAppStateRecord();
      if (Number(body.revision || 0) !== current.revision) return { status: 409, payload: { error: "服务端数据已更新，请重新加载", conflict: true, revision: current.revision } };
      const state = normalizeAppState(body.state);
      const rules = normalizeMonitorRules(state.shops.filter(shop => shop.enabled).flatMap(shop => shop.products.filter(product => product.monitored).map(product => ({
        id: `${shop.id}:${product.id}`,
        shopId: shop.id,
        shopName: shop.name,
        shopUrl: shop.url,
        token: shop.token,
        productKey: product.id,
        productName: product.name,
        notifyRecovery: state.notifyRecovery
      }))));
      const updatedAt = new Date().toISOString();
      const nextRevision = current.revision + 1;
      await writeAppStateRecord({ revision: nextRevision, updatedAt, state });
      await writeMonitorConfig({ interval: state.interval, rules, updatedAt });
      scheduleBackgroundMonitor(state.interval);
      if (rules.length) void runBackgroundMonitor();
      return { status: 200, payload: { saved: true, revision: nextRevision, updatedAt, verificationQueued: rules.length > 0 } };
    });
    return sendJson(response, result.payload, result.status);
  } catch (error) {
    return sendJson(response, { error: error.message || "服务端状态保存失败" }, 400);
  }
}

async function handleStock(request, response, url) {
  const authorization = await appStateAuthorization(request, { allowUnconfigured: true });
  if (!authorization.ok) return sendJson(response, { error: authorization.error }, authorization.status);
  const token = url.searchParams.get("token") || url.searchParams.get("shop");
  if (!token || !/^[A-Za-z0-9]+$/.test(token)) return sendJson(response, { error: "缺少有效的店铺 token" }, 400);
  const dispatcher = dispatcherFor(request);
  let source;
  try { source = stockSource(url.searchParams.get("url"), token); }
  catch (error) { return sendJson(response, { error: error.message }, 400); }
  try {
    return sendJson(response, await fetchStockData(token, dispatcher, source));
  } catch (error) {
    return sendJson(response, { error: "店铺接口暂时不可用", detail: error.message }, 502);
  }
}

async function deliver(url, body, dispatcher) {
  try {
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), dispatcher, signal: AbortSignal.timeout(upstreamTimeoutMs) });
    return { ok: result.ok, status: result.status };
  } catch (error) {
    return { ok: false, error: error.message || "投递失败" };
  }
}

async function notifyAll(text, dispatcher) {
  const storedConfig = await readNotificationConfig();
  const settings = notificationSettings(storedConfig);
  const tasks = [];
  if (settings.FEISHU_WEBHOOK) tasks.push(deliver(settings.FEISHU_WEBHOOK, { msg_type: "text", content: { text } }, dispatcher).then(result => ({ channel: "feishu", ...result })));
  if (settings.QQ_WEBHOOK) tasks.push(deliver(settings.QQ_WEBHOOK, { msg_type: "text", content: text, message: text }, dispatcher).then(result => ({ channel: "qq", ...result })));
  if (settings.TELEGRAM_BOT_TOKEN && settings.TELEGRAM_CHAT_ID) tasks.push(deliver(`https://api.telegram.org/bot${settings.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: settings.TELEGRAM_CHAT_ID, text }, dispatcher).then(result => ({ channel: "telegram", ...result })));
  if (settings.DINGTALK_WEBHOOK) tasks.push(deliver(settings.DINGTALK_WEBHOOK, { msgtype: "text", text: { content: text } }, dispatcher).then(result => ({ channel: "dingtalk", ...result })));
  if (settings.WECOM_WEBHOOK) tasks.push(deliver(settings.WECOM_WEBHOOK, { msgtype: "text", text: { content: text } }, dispatcher).then(result => ({ channel: "wecom", ...result })));
  return Promise.all(tasks);
}

async function notificationStatus() {
  const config = await readNotificationConfig();
  const settings = notificationSettings(config);
  return {
    channels: {
      feishu: Boolean(settings.FEISHU_WEBHOOK),
      qq: Boolean(settings.QQ_WEBHOOK),
      telegram: Boolean(settings.TELEGRAM_BOT_TOKEN && settings.TELEGRAM_CHAT_ID),
      dingtalk: Boolean(settings.DINGTALK_WEBHOOK),
      wecom: Boolean(settings.WECOM_WEBHOOK)
    },
    webConfigSupported: true,
    backgroundMonitorSupported: true,
    setupRequired: !isAdminConfigured(config),
    deploymentMode: process.env.DEPLOYMENT_MODE || "node"
  };
}

async function handleNotificationConfig(request, response) {
  try {
    const body = await readJson(request);
    const channel = body.channel;
    if (!notificationFields[channel]) return sendJson(response, { error: "不支持的通知渠道" }, 400);
    const config = await readNotificationConfig();
    const token = String(body.adminToken || "");

    if (!isAdminConfigured(config)) {
      if (!body.setupAdmin || token.length < 8) return sendJson(response, { error: "请先设置至少 8 位管理口令" }, 400);
      const salt = randomBytes(16).toString("hex");
      config.admin = { salt, hash: tokenHash(token, salt).toString("hex") };
    } else if (!authenticateAdmin(token, config)) {
      return sendJson(response, { error: "管理口令错误" }, 401);
    }

    config.channels ||= {};
    const fields = notificationFields[channel];
    if (body.clear) {
      for (const field of fields) config.channels[field] = "";
    } else {
      const values = body.values || {};
      for (const field of fields) {
        const value = String(values[field] || "").trim();
        if (!value) return sendJson(response, { error: "请完整填写渠道配置" }, 400);
        if (field.endsWith("_WEBHOOK") && !validWebhook(value)) return sendJson(response, { error: "Webhook 地址无效" }, 400);
        config.channels[field] = value;
      }
    }
    await writeNotificationConfig(config);
    return sendJson(response, { saved: true, ...(await notificationStatus()) });
  } catch (error) {
    return sendJson(response, { error: error.message || "通知配置保存失败" }, 400);
  }
}

async function handleNotify(request, response) {
  if (!requestIsSameOrigin(request)) return sendJson(response, { error: "仅允许同源页面发送通知" }, 403);
  const authorization = await appStateAuthorization(request);
  if (!authorization.ok) return sendJson(response, { error: authorization.error }, authorization.status);
  try {
    const body = await readJson(request);
    const text = body.text || `库存事件：${body.product || "商品"}，当前库存 ${body.stock ?? 0}`;
    const dispatcher = dispatcherFor(request);
    const results = await notifyAll(text, dispatcher);
    return sendJson(response, { sent: results.some(result => result.ok), configured: results.length, results });
  } catch (error) {
    return sendJson(response, { error: error.message || "通知发送失败" }, 400);
  }
}

function normalizeMonitorInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 5;
}

async function readMonitorConfig() {
  try {
    const config = JSON.parse(await readFile(monitorConfigFile, "utf8"));
    return {
      interval: normalizeMonitorInterval(config.interval),
      rules: Array.isArray(config.rules) ? config.rules : [],
      updatedAt: config.updatedAt || null
    };
  } catch {
    return { interval: normalizeMonitorInterval(process.env.MONITOR_INTERVAL_MINUTES || 5), rules: [], updatedAt: null };
  }
}

async function writeMonitorConfig(config) {
  await mkdir(resolve(monitorConfigFile, ".."), { recursive: true });
  await writeFile(monitorConfigFile, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}

function normalizeMonitorRule(rule, index) {
  if (!rule || typeof rule !== "object") throw new Error(`第 ${index + 1} 条监控规则无效`);
  const token = String(rule.token || "").trim();
  const shopUrl = String(rule.shopUrl || "").trim();
  const shopId = String(rule.shopId || "").trim().slice(0, 200);
  const shopName = String(rule.shopName || "店铺").trim().slice(0, 300) || "店铺";
  const productKey = String(rule.productKey || "").trim().slice(0, 300);
  const productName = String(rule.productName || "").trim().slice(0, 500);
  if (!token || !/^[A-Za-z0-9]+$/.test(token)) throw new Error(`第 ${index + 1} 条规则缺少有效店铺标识`);
  if (!productKey && !productName) throw new Error(`第 ${index + 1} 条规则缺少商品标识`);
  if (shopUrl.length > 2048) throw new Error(`第 ${index + 1} 条规则的店铺链接过长`);
  stockSource(shopUrl, token);
  return {
    id: String(rule.id || `${shopId || "shop"}:${productKey || productName}`).slice(0, 600),
    shopId,
    shopName,
    shopUrl,
    token,
    productKey,
    productName,
    notifyRecovery: rule.notifyRecovery !== false
  };
}

function normalizeMonitorRules(rules) {
  if (!Array.isArray(rules)) throw new Error("监控规则必须是数组");
  if (rules.length > 500) throw new Error("监控规则不能超过 500 条");
  const normalized = rules.map(normalizeMonitorRule);
  return [...new Map(normalized.map(rule => [rule.id, rule])).values()];
}

async function monitorConfigStatus() {
  const config = await readMonitorConfig();
  return { backgroundMonitorSupported: true, ruleCount: config.rules.length, interval: config.interval, updatedAt: config.updatedAt };
}

async function handleMonitorConfig(request, response) {
  if (!requestIsSameOrigin(request)) return sendJson(response, { error: "仅允许同源页面更新后台监控" }, 403);
  const authorization = await appStateAuthorization(request);
  if (!authorization.ok) return sendJson(response, { error: authorization.error }, authorization.status);
  try {
    const body = await readJson(request);
    const config = {
      interval: normalizeMonitorInterval(body.interval),
      rules: normalizeMonitorRules(body.rules),
      updatedAt: new Date().toISOString()
    };
    await writeMonitorConfig(config);
    scheduleBackgroundMonitor(config.interval);
    void runBackgroundMonitor();
    return sendJson(response, { saved: true, ...(await monitorConfigStatus()) });
  } catch (error) {
    return sendJson(response, { error: error.message || "后台监控配置保存失败" }, 400);
  }
}

async function serveStatic(response, pathname) {
  let relativePath;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  } catch {
    return sendJson(response, { error: "非法路径" }, 400);
  }
  if (!publicFiles.has(relativePath)) return sendJson(response, { error: "文件不存在" }, 404);
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return sendJson(response, { error: "非法路径" }, 403);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not file");
    const content = await readFile(filePath);
    response.writeHead(200, { "content-type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream", "cache-control": relativePath === "index.html" ? "no-store" : "no-cache" });
    response.end(content);
  } catch {
    sendJson(response, { error: "文件不存在" }, 404);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") return sendJson(response, {}, 204);
  if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, { ok: true, time: Date.now() });
  if (request.method === "GET" && url.pathname === "/api/stock") return handleStock(request, response, url);
  if (request.method === "GET" && url.pathname === "/api/app-state") return handleAppStateRead(request, response);
  if (request.method === "POST" && url.pathname === "/api/app-state") return handleAppStateSave(request, response);
  if (request.method === "GET" && url.pathname === "/api/notify") return sendJson(response, await notificationStatus());
  if (request.method === "POST" && url.pathname === "/api/notify") return handleNotify(request, response);
  if (request.method === "POST" && url.pathname === "/api/notification-config") return handleNotificationConfig(request, response);
  if (request.method === "GET" && url.pathname === "/api/monitor-config") return sendJson(response, await monitorConfigStatus());
  if (request.method === "POST" && url.pathname === "/api/monitor-config") return handleMonitorConfig(request, response);
  if (request.method === "GET" || request.method === "HEAD") return serveStatic(response, url.pathname);
  return sendJson(response, { error: "方法不支持" }, 405);
});

async function readMonitorState() {
  try { return JSON.parse(await readFile(monitorStateFile, "utf8")); } catch { return {}; }
}

async function writeMonitorState(value) {
  await mkdir(resolve(monitorStateFile, ".."), { recursive: true });
  await writeFile(monitorStateFile, JSON.stringify(value, null, 2), "utf8");
}

function environmentMonitorRules() {
  if (process.env.MONITOR_RULES_JSON) {
    try {
      const rules = JSON.parse(process.env.MONITOR_RULES_JSON);
      if (Array.isArray(rules)) return rules.filter(rule => rule.token && (rule.productKey || rule.productName));
    } catch (error) {
      console.error(`[后台监控] MONITOR_RULES_JSON 解析失败：${error.message}`);
    }
  }
  if (process.env.MONITOR_TOKEN && (process.env.MONITOR_PRODUCT_KEY || process.env.MONITOR_PRODUCT_NAME)) {
    return [{ token: process.env.MONITOR_TOKEN, productKey: process.env.MONITOR_PRODUCT_KEY, productName: process.env.MONITOR_PRODUCT_NAME }];
  }
  return [];
}

async function monitorRules() {
  const config = await readMonitorConfig();
  const rules = [...config.rules];
  if (process.env.MONITOR_ENABLED === "true") rules.push(...environmentMonitorRules());
  const uniqueRules = new Map();
  for (const rule of rules) {
    const key = `${rule.token}:${rule.productKey || rule.productName}`;
    if (!uniqueRules.has(key)) uniqueRules.set(key, rule);
  }
  return [...uniqueRules.values()];
}

async function runBackgroundMonitor() {
  if (backgroundMonitorRunning) return;
  backgroundMonitorRunning = true;
  try {
    const rules = await monitorRules();
    const previous = await readMonitorState();
    const next = { rules: {}, checkedAt: new Date().toISOString() };
    const shopCache = new Map();
    const observations = [];
    for (const [index, rule] of rules.entries()) {
      try {
        const source = stockSource(rule.shopUrl || "", rule.token);
        const cacheKey = `${source.demo ? "demo" : source.upstream}:${rule.token}`;
        let data = shopCache.get(cacheKey);
        if (!data) {
          data = await fetchStockData(rule.token, defaultDispatcher, source);
          shopCache.set(cacheKey, data);
        }
        const product = data.products.find(item => item.id === rule.productKey) || data.products.find(item => rule.productName && item.name.includes(rule.productName));
        if (!product) { console.error(`[后台监控] 第 ${index + 1} 条规则未找到商品`); continue; }
        const key = rule.id || `${rule.token}:${product.id}`;
        const oldStock = previous.rules?.[key]?.stock ?? (rules.length === 1 ? previous.stock : undefined);
        const changed = Number.isFinite(oldStock) && oldStock !== product.stock;
        const shouldNotify = product.stock === 0 || (oldStock === 0 && rule.notifyRecovery !== false);
        let notificationText = "";
        let deliveries = [];
        if (changed && shouldNotify) {
          const status = product.stock === 0 ? "库存为 0" : `库存恢复至 ${product.stock}`;
          notificationText = `${rule.shopName || data.shop.name}：${product.name}，${status}`;
          deliveries = await notifyAll(notificationText, defaultDispatcher);
          console.log(`[后台监控] 检测到库存状态变化并完成通知投递`);
        }
        next.rules[key] = { productKey: product.id, stock: product.stock };
        observations.push({ rule, product, notificationText, deliveries });
      } catch (error) {
        console.error(`[后台监控] 第 ${index + 1} 条规则检查失败：${error.message}`);
      }
    }
    await writeMonitorState(next);
    if (observations.length) {
      await withAppStateLock(async () => {
        const record = await readAppStateRecord();
        if (!record.initialized) return;
        const checkedAt = new Date().toISOString();
        let changed = false;
        for (const observation of observations) {
          const shop = record.state.shops.find(item => item.id === observation.rule.shopId);
          const product = shop?.products.find(item => item.id === observation.product.id);
          if (!shop || !product) continue;
          const priorStock = Number(product.stock);
          product.name = observation.product.name;
          product.category = observation.product.category;
          product.price = observation.product.price;
          product.stock = observation.product.stock;
          shop.lastChecked = Date.now();
          changed = true;
          if (priorStock !== observation.product.stock && (priorStock === 0 || observation.product.stock === 0)) {
            const status = observation.product.stock === 0 ? "库存为 0" : `库存恢复至 ${observation.product.stock}`;
            record.state.events.unshift({ shopId: shop.id, productKey: product.id, product: product.name, text: status, tone: observation.product.stock === 0 ? "red" : "green", read: false, createdAt: checkedAt });
            record.state.activity.unshift({ shopId: shop.id, icon: observation.product.stock === 0 ? "!" : "↻", tone: observation.product.stock === 0 ? "red" : "", title: `${product.name} ${status}`, meta: `${shop.name} · 服务端后台轮询`, createdAt: checkedAt });
          }
          for (const delivery of observation.deliveries) {
            record.state.notificationLog.unshift({ shopId: shop.id, channel: delivery.channel, text: observation.notificationText, success: Boolean(delivery.ok), statusCode: delivery.status || null, createdAt: checkedAt });
          }
        }
        if (!changed) return;
        record.state.events = record.state.events.slice(0, 100);
        record.state.activity = record.state.activity.slice(0, 100);
        record.state.notificationLog = record.state.notificationLog.slice(0, 100);
        await writeAppStateRecord({ revision: record.revision + 1, updatedAt: checkedAt, state: record.state });
      });
    }
  } catch (error) {
    console.error(`[后台监控] 检查失败：${error.message}`);
  } finally {
    backgroundMonitorRunning = false;
  }
}

function scheduleBackgroundMonitor(interval) {
  const minutes = normalizeMonitorInterval(interval);
  if (backgroundMonitorTimer) clearInterval(backgroundMonitorTimer);
  backgroundMonitorTimer = setInterval(runBackgroundMonitor, minutes * 60 * 1000);
  backgroundMonitorTimer.unref();
  return minutes;
}

server.listen(port, host, async () => {
  console.log(`货架雷达已启动：http://${host}:${port}`);
  const config = await readMonitorConfig();
  const minutes = scheduleBackgroundMonitor(config.interval || process.env.MONITOR_INTERVAL_MINUTES);
  void runBackgroundMonitor();
  console.log(`[后台监控] 已就绪，每 ${minutes} 分钟检查一次；网页同步规则自动生效`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
