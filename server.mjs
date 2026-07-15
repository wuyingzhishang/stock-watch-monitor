import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { fetch, ProxyAgent } from "undici";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "0.0.0.0";
const upstream = String(process.env.UPSTREAM_BASE_URL || "").replace(/\/+$/, "");
const demoMode = process.env.DEMO_MODE !== "false";
const allowDynamicUpstream = process.env.ALLOW_DYNAMIC_UPSTREAM === "true";
const defaultProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const defaultDispatcher = createDispatcher(defaultProxy);
const monitorStateFile = process.env.MONITOR_STATE_FILE || "/data/monitor-state.json";
const notificationConfigFile = process.env.NOTIFICATION_CONFIG_FILE || "/data/notification-config.json";
const publicFiles = new Set(["index.html", "styles.css", "state-store.js", "app.js"]);
const notificationFields = {
  feishu: ["FEISHU_WEBHOOK"],
  qq: ["QQ_WEBHOOK"],
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
  dingtalk: ["DINGTALK_WEBHOOK"],
  wecom: ["WECOM_WEBHOOK"]
};

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

function sendJson(response, data, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-proxy-url" });
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

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求体过大");
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
    dispatcher
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

async function handleStock(request, response, url) {
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
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), dispatcher });
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
  if (request.method === "GET" && url.pathname === "/api/notify") return sendJson(response, await notificationStatus());
  if (request.method === "POST" && url.pathname === "/api/notify") return handleNotify(request, response);
  if (request.method === "POST" && url.pathname === "/api/notification-config") return handleNotificationConfig(request, response);
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

function monitorRules() {
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

async function runBackgroundMonitor() {
  const rules = monitorRules();
  if (!rules.length) return;
  try {
    const previous = await readMonitorState();
    const next = { rules: {}, checkedAt: new Date().toISOString() };
    const shopCache = new Map();
    for (const rule of rules) {
      let data = shopCache.get(rule.token);
      if (!data) {
        data = await fetchStockData(rule.token, defaultDispatcher);
        shopCache.set(rule.token, data);
      }
      const product = data.products.find(item => item.id === rule.productKey) || data.products.find(item => rule.productName && item.name.includes(rule.productName));
      if (!product) { console.error(`[后台监控] ${rule.token} 未找到商品：${rule.productKey || rule.productName}`); continue; }
      const key = `${rule.token}:${product.id}`;
      const oldStock = previous.rules?.[key]?.stock ?? (rules.length === 1 ? previous.stock : undefined);
      const changed = Number.isFinite(oldStock) && oldStock !== product.stock;
      if (changed && (oldStock === 0 || product.stock === 0)) {
        const status = product.stock === 0 ? "库存为 0" : `库存恢复至 ${product.stock}`;
        await notifyAll(`${data.shop.name}：${product.name}，${status}`, defaultDispatcher);
        console.log(`[后台监控] ${product.name}：${status}`);
      }
      next.rules[key] = { token: rule.token, productKey: product.id, productName: product.name, stock: product.stock };
    }
    await writeMonitorState(next);
  } catch (error) {
    console.error(`[后台监控] 检查失败：${error.message}`);
  }
}

server.listen(port, host, () => {
  console.log(`货架雷达已启动：http://${host}:${port}`);
  if (process.env.MONITOR_ENABLED === "true") {
    const requestedMinutes = Number(process.env.MONITOR_INTERVAL_MINUTES || 5);
    const minutes = Number.isFinite(requestedMinutes) ? Math.max(1, requestedMinutes) : 5;
    runBackgroundMonitor();
    setInterval(runBackgroundMonitor, minutes * 60 * 1000).unref();
    console.log(`[后台监控] 已启用，每 ${minutes} 分钟检查一次`);
  }
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
