const STATIC_PATHS = new Set(["/", "/index.html", "/styles.css", "/app.js"]);
const MAX_RULES = 100;
const MAX_SHOPS = 50;
const MAX_PRODUCTS = 2000;
const MAX_TIMELINE_ITEMS = 100;
const CLOUD_STATE_SCHEMA_VERSION = 4;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-admin-token"
    }
  });
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

function stockSource(shopUrl, token, env) {
  const configuredUpstream = String(env.UPSTREAM_BASE_URL || "").replace(/\/+$/, "");
  const demoMode = env.DEMO_MODE !== "false";
  if (!shopUrl) {
    if (demoMode) return { demo: true, upstream: "" };
    if (configuredUpstream) return { demo: false, upstream: configuredUpstream };
    throw new Error("未配置库存上游地址");
  }
  const parsed = new URL(shopUrl);
  const tokenMatch = parsed.pathname.match(/^\/shop\/([A-Za-z0-9]+)\/?$/i);
  if (parsed.protocol !== "https:" || !tokenMatch || tokenMatch[1] !== token) throw new Error("店铺链接必须是包含相同 token 的 HTTPS 地址");
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "demo.example.com") return { demo: true, upstream: "" };
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.includes(":") || /^\d+(\.\d+){3}$/.test(hostname)) throw new Error("不允许使用本地或 IP 地址作为动态上游");
  if (env.ALLOW_DYNAMIC_UPSTREAM === "true") return { demo: false, upstream: parsed.origin };
  if (!demoMode && configuredUpstream) return { demo: false, upstream: configuredUpstream };
  throw new Error("当前仅启用模拟数据；真实店铺需开启 ALLOW_DYNAMIC_UPSTREAM");
}

async function post(upstream, path, payload) {
  const response = await fetch(`${upstream}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0 (compatible; StockWatchMonitor/0.1)",
      referer: `${upstream}/`
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`上游接口返回 ${response.status}`);
  const data = await response.json();
  if (data.code !== 1) throw new Error(data.msg || "上游接口错误");
  return data.data;
}

async function fetchStockData(token, shopUrl, env) {
  const source = stockSource(shopUrl, token, env);
  if (source.demo) return demoStockData(token);
  const [shop, categories] = await Promise.all([
    post(source.upstream, "/shopApi/Shop/info", { token }),
    post(source.upstream, "/shopApi/Shop/categoryList", { token, goods_type: "card" })
  ]);
  const pages = [];
  const pageSize = 50;
  for (let current = 1; current <= 20; current += 1) {
    const page = await post(source.upstream, "/shopApi/Shop/goodsList", { token, goods_type: "card", current, pageSize, category_id: 0, keywords: "" });
    pages.push(page);
    if (!Array.isArray(page?.list) || page.list.length < pageSize) break;
  }
  return {
    fetchedAt: Date.now(),
    shop: { name: shop.nickname, token: shop.token, link: shop.link, description: shop.description },
    categories: (categories || []).map(item => item.name),
    products: pages.flatMap(result => result?.list || []).map(item => ({
      id: item.goods_key,
      name: item.name,
      category: item.category?.name || "未分类",
      price: Number(item.price || 0),
      stock: Number(item.extend?.stock_count || 0),
      monitored: false,
      favorite: false
    }))
  };
}

function normalizeInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) ? Math.min(60, Math.max(5, Math.round(minutes))) : 5;
}

function boundedText(value, field, max = 500) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw new Error(`${field}无效`);
  return text;
}

function normalizeRules(rules) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error(`监控规则必须是最多 ${MAX_RULES} 条的数组`);
  const normalized = rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") throw new Error(`第 ${index + 1} 条监控规则无效`);
    const shopToken = boundedText(rule.token, "店铺 token", 80);
    if (!/^[A-Za-z0-9]+$/.test(shopToken)) throw new Error("店铺 token 只能包含字母和数字");
    const shopUrl = boundedText(rule.shopUrl, "店铺链接", 2000);
    stockSource(shopUrl, shopToken, { DEMO_MODE: "false", ALLOW_DYNAMIC_UPSTREAM: "true" });
    return {
      id: boundedText(rule.id, "规则 ID", 180),
      shopName: boundedText(rule.shopName, "店铺名称"),
      shopUrl,
      token: shopToken,
      productKey: boundedText(rule.productKey, "商品 ID", 180),
      productName: boundedText(rule.productName, "商品名称"),
      notifyRecovery: Boolean(rule.notifyRecovery)
    };
  });
  return [...new Map(normalized.map(rule => [rule.id, rule])).values()];
}

function configFingerprint(interval, rules) {
  const input = JSON.stringify({ interval, rules });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function optionalText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function booleanValue(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function isoDate(value, fallback = new Date().toISOString()) {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function defaultAppState() {
  const demo = demoStockData("DEMO001");
  return {
    schemaVersion: CLOUD_STATE_SCHEMA_VERSION,
    shops: [{
      id: "shop-demo001",
      name: "示例店铺",
      customName: true,
      url: "https://demo.example.com/shop/DEMO001",
      token: "DEMO001",
      note: "开源演示数据",
      enabled: true,
      favorite: true,
      lastChecked: demo.fetchedAt,
      categories: demo.categories,
      products: demo.products.map((product, index) => ({
        ...product,
        monitored: index === 0,
        favorite: index === 0 || index === demo.products.length - 1
      }))
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

function normalizeAppState(input, env) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("云端状态无效");
  const rawShops = Array.isArray(input.shops) ? input.shops : [];
  if (rawShops.length > MAX_SHOPS) throw new Error(`店铺数量不能超过 ${MAX_SHOPS} 个`);
  let productCount = 0;
  const now = new Date().toISOString();
  const shops = rawShops.map((shop, shopIndex) => {
    if (!shop || typeof shop !== "object") throw new Error(`第 ${shopIndex + 1} 个店铺无效`);
    const id = boundedText(shop.id, "店铺 ID", 120);
    const name = boundedText(shop.name, "店铺名称", 200);
    const token = boundedText(shop.token, "店铺 token", 80);
    if (!/^[A-Za-z0-9]+$/.test(token)) throw new Error("店铺 token 只能包含字母和数字");
    const url = boundedText(shop.url, "店铺链接", 2000);
    stockSource(url, token, env);
    const rawProducts = Array.isArray(shop.products) ? shop.products : [];
    productCount += rawProducts.length;
    const products = rawProducts.map((product, productIndex) => {
      if (!product || typeof product !== "object") throw new Error(`${name} 的第 ${productIndex + 1} 个商品无效`);
      return {
        id: boundedText(product.id, "商品 ID", 180),
        name: boundedText(product.name, "商品名称", 500),
        category: optionalText(product.category || "未分类", 200) || "未分类",
        price: Number.isFinite(Number(product.price)) ? Number(product.price) : 0,
        stock: Number.isFinite(Number(product.stock)) ? Math.max(0, Math.round(Number(product.stock))) : 0,
        monitored: Boolean(product.monitored),
        favorite: Boolean(product.favorite),
        sortOrder: productIndex
      };
    });
    return {
      id,
      name,
      customName: booleanValue(shop.customName),
      url,
      token,
      note: optionalText(shop.note, 1000),
      enabled: booleanValue(shop.enabled, true),
      favorite: booleanValue(shop.favorite),
      remoteName: optionalText(shop.remoteName, 200),
      categories: Array.isArray(shop.categories) ? shop.categories.map(item => optionalText(item, 200)).filter(Boolean).slice(0, 200) : [],
      lastCheckedAt: isoDate(shop.lastChecked, now),
      sortOrder: shopIndex,
      products
    };
  });
  if (productCount > MAX_PRODUCTS) throw new Error(`商品数量不能超过 ${MAX_PRODUCTS} 个`);
  const shopIds = new Set(shops.map(shop => shop.id));
  if (shopIds.size !== shops.length) throw new Error("店铺 ID 不能重复");

  const normalizeTimeline = (items, mapper) => (Array.isArray(items) ? items : [])
    .slice(0, MAX_TIMELINE_ITEMS)
    .map((item, index) => mapper(item && typeof item === "object" ? item : {}, index));

  return {
    schemaVersion: CLOUD_STATE_SCHEMA_VERSION,
    shops,
    selectedShopId: shopIds.has(input.selectedShopId) ? input.selectedShopId : (shops[0]?.id || null),
    interval: normalizeInterval(input.interval),
    keepLastStock: booleanValue(input.keepLastStock, true),
    notifyRecovery: booleanValue(input.notifyRecovery, true),
    notifyOnlyMonitored: booleanValue(input.notifyOnlyMonitored, true),
    activity: normalizeTimeline(input.activity, item => ({
      shopId: shopIds.has(item.shopId) ? item.shopId : null,
      icon: optionalText(item.icon, 20),
      tone: optionalText(item.tone, 30),
      title: boundedText(item.title || "库存动态", "动态标题", 500),
      meta: optionalText(item.meta, 1000),
      createdAt: isoDate(item.createdAt || item.time, now)
    })),
    events: normalizeTimeline(input.events, item => ({
      shopId: shopIds.has(item.shopId) ? item.shopId : null,
      productKey: optionalText(item.productKey, 180),
      product: boundedText(item.product || "商品", "事件商品", 500),
      text: boundedText(item.text || "库存变化", "事件内容", 1000),
      tone: item.tone === "green" ? "green" : "red",
      read: Boolean(item.read),
      createdAt: isoDate(item.createdAt || item.time, now)
    })),
    notificationLog: normalizeTimeline(input.notificationLog, item => ({
      shopId: shopIds.has(item.shopId) ? item.shopId : null,
      channel: boundedText(item.channel || "通知队列", "通知渠道", 100),
      text: boundedText(item.text || "库存通知", "通知内容", 1000),
      success: item.success !== false,
      statusCode: Number.isFinite(Number(item.statusCode)) ? Number(item.statusCode) : null,
      createdAt: isoDate(item.createdAt || item.time, now)
    }))
  };
}

function parseJsonArray(value) {
  try { return Array.isArray(JSON.parse(value || "[]")) ? JSON.parse(value || "[]") : []; } catch { return []; }
}

async function readAppState(env) {
  const config = await env.DB.prepare("SELECT schema_version, revision, selected_shop_id, interval_minutes, keep_last_stock, notify_recovery, notify_only_monitored, updated_at FROM app_config WHERE id = 1").first();
  if (!config) return { initialized: false, revision: 0, updatedAt: null, state: defaultAppState() };
  const [shopRows, productRows, activityRows, eventRows, notificationRows] = await Promise.all([
    env.DB.prepare("SELECT shop_id, name, custom_name, url, shop_token, note, enabled, favorite, remote_name, categories_json, sort_order, last_checked_at FROM shops ORDER BY sort_order, shop_id").all(),
    env.DB.prepare("SELECT shop_id, product_key, name, category, price, stock, monitored, favorite, sort_order, updated_at FROM products ORDER BY shop_id, sort_order, product_key").all(),
    env.DB.prepare("SELECT shop_id, icon, tone, title, meta, created_at FROM activity ORDER BY created_at DESC, activity_id DESC LIMIT 100").all(),
    env.DB.prepare("SELECT shop_id, product_key, product_name, message, tone, is_read, created_at FROM inventory_events ORDER BY created_at DESC, event_id DESC LIMIT 100").all(),
    env.DB.prepare("SELECT shop_id, channel, message, success, status_code, created_at FROM notification_log ORDER BY created_at DESC, notification_id DESC LIMIT 100").all()
  ]);
  const productsByShop = new Map();
  for (const product of productRows.results || []) {
    if (!productsByShop.has(product.shop_id)) productsByShop.set(product.shop_id, []);
    productsByShop.get(product.shop_id).push({
      id: product.product_key,
      name: product.name,
      category: product.category,
      price: Number(product.price || 0),
      stock: Number(product.stock || 0),
      monitored: Boolean(product.monitored),
      favorite: Boolean(product.favorite),
      updatedAt: product.updated_at
    });
  }
  const shops = (shopRows.results || []).map(shop => ({
    id: shop.shop_id,
    name: shop.name,
    customName: Boolean(shop.custom_name),
    url: shop.url,
    token: shop.shop_token,
    note: shop.note || "",
    enabled: Boolean(shop.enabled),
    favorite: Boolean(shop.favorite),
    remoteName: shop.remote_name || "",
    categories: parseJsonArray(shop.categories_json),
    lastChecked: shop.last_checked_at ? new Date(shop.last_checked_at).getTime() : 0,
    products: productsByShop.get(shop.shop_id) || []
  }));
  return {
    initialized: true,
    revision: Number(config.revision || 0),
    updatedAt: config.updated_at,
    state: {
      schemaVersion: CLOUD_STATE_SCHEMA_VERSION,
      shops,
      selectedShopId: shops.some(shop => shop.id === config.selected_shop_id) ? config.selected_shop_id : (shops[0]?.id || null),
      interval: normalizeInterval(config.interval_minutes),
      keepLastStock: Boolean(config.keep_last_stock),
      notifyRecovery: Boolean(config.notify_recovery),
      notifyOnlyMonitored: Boolean(config.notify_only_monitored),
      activity: (activityRows.results || []).map(item => ({ shopId: item.shop_id, icon: item.icon, tone: item.tone, title: item.title, meta: item.meta, createdAt: item.created_at })),
      events: (eventRows.results || []).map(item => ({ shopId: item.shop_id, productKey: item.product_key, product: item.product_name, text: item.message, tone: item.tone, read: Boolean(item.is_read), createdAt: item.created_at })),
      notificationLog: (notificationRows.results || []).map(item => ({ shopId: item.shop_id, channel: item.channel, text: item.message, success: Boolean(item.success), statusCode: item.status_code, createdAt: item.created_at }))
    }
  };
}

async function saveAppState(request, env, ctx) {
  if (!isSameOrigin(request)) return json({ error: "仅允许同源页面保存数据" }, 403);
  if (!env.DB) return json({ error: "未配置 D1 数据库绑定" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try {
    const body = await request.json();
    const current = await env.DB.prepare("SELECT revision FROM app_config WHERE id = 1").first();
    const currentRevision = Number(current?.revision || 0);
    if (Number(body.revision || 0) !== currentRevision) return json({ error: "云端数据已更新，请重新加载", conflict: true, revision: currentRevision }, 409);
    const state = normalizeAppState(body.state, env);
    const updatedAt = new Date().toISOString();
    const nextRevision = currentRevision + 1;
    const rules = state.shops.filter(shop => shop.enabled).flatMap(shop => shop.products.filter(product => product.monitored).map(product => ({
      id: `${shop.id}:${product.id}`,
      shopName: shop.name,
      shopUrl: shop.url,
      token: shop.token,
      productKey: product.id,
      productName: product.name,
      notifyRecovery: state.notifyRecovery
    })));
    if (rules.length > MAX_RULES) throw new Error(`重点监控商品不能超过 ${MAX_RULES} 个`);
    const fingerprint = configFingerprint(state.interval, rules);
    const previousMonitor = await env.DB.prepare("SELECT config_hash FROM monitor_config WHERE id = 1").first();
    const configurationChanged = previousMonitor?.config_hash !== fingerprint;
    const statements = [
      env.DB.prepare("DELETE FROM notification_log"),
      env.DB.prepare("DELETE FROM inventory_events"),
      env.DB.prepare("DELETE FROM activity"),
      env.DB.prepare("DELETE FROM products"),
      env.DB.prepare("DELETE FROM shops"),
      env.DB.prepare("INSERT INTO app_config (id, schema_version, revision, selected_shop_id, interval_minutes, keep_last_stock, notify_recovery, notify_only_monitored, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, revision = excluded.revision, selected_shop_id = excluded.selected_shop_id, interval_minutes = excluded.interval_minutes, keep_last_stock = excluded.keep_last_stock, notify_recovery = excluded.notify_recovery, notify_only_monitored = excluded.notify_only_monitored, updated_at = excluded.updated_at").bind(CLOUD_STATE_SCHEMA_VERSION, nextRevision, state.selectedShopId, state.interval, Number(state.keepLastStock), Number(state.notifyRecovery), Number(state.notifyOnlyMonitored), updatedAt),
      env.DB.prepare("INSERT INTO monitor_config (id, interval_minutes, updated_at, last_run_at, config_hash, last_success_at, last_success_count, ready_notified_at) VALUES (1, ?, ?, NULL, ?, NULL, 0, NULL) ON CONFLICT(id) DO UPDATE SET interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at, last_run_at = CASE WHEN monitor_config.config_hash = excluded.config_hash THEN monitor_config.last_run_at ELSE NULL END, config_hash = excluded.config_hash, ready_notified_at = CASE WHEN monitor_config.config_hash = excluded.config_hash THEN monitor_config.ready_notified_at ELSE NULL END").bind(state.interval, updatedAt, fingerprint),
      env.DB.prepare("DELETE FROM monitor_rules")
    ];
    for (const shop of state.shops) {
      statements.push(env.DB.prepare("INSERT INTO shops (shop_id, name, custom_name, url, shop_token, note, enabled, favorite, remote_name, categories_json, sort_order, last_checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(shop.id, shop.name, Number(shop.customName), shop.url, shop.token, shop.note, Number(shop.enabled), Number(shop.favorite), shop.remoteName || null, JSON.stringify(shop.categories), shop.sortOrder, shop.lastCheckedAt, updatedAt, updatedAt));
      for (const product of shop.products) statements.push(env.DB.prepare("INSERT INTO products (shop_id, product_key, name, category, price, stock, monitored, favorite, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(shop.id, product.id, product.name, product.category, product.price, product.stock, Number(product.monitored), Number(product.favorite), product.sortOrder, updatedAt));
    }
    for (const item of state.activity) statements.push(env.DB.prepare("INSERT INTO activity (shop_id, icon, tone, title, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(item.shopId, item.icon, item.tone, item.title, item.meta, item.createdAt));
    for (const item of state.events) statements.push(env.DB.prepare("INSERT INTO inventory_events (shop_id, product_key, product_name, message, tone, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(item.shopId, item.productKey || null, item.product, item.text, item.tone, Number(item.read), item.createdAt));
    for (const item of state.notificationLog) statements.push(env.DB.prepare("INSERT INTO notification_log (shop_id, channel, message, success, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(item.shopId, item.channel, item.text, Number(item.success), item.statusCode, item.createdAt));
    for (const rule of rules) statements.push(env.DB.prepare("INSERT INTO monitor_rules (rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(rule.id, rule.shopName, rule.shopUrl, rule.token, rule.productKey, rule.productName, Number(rule.notifyRecovery)));
    await env.DB.batch(statements);
    const verificationQueued = configurationChanged && rules.length > 0;
    if (verificationQueued) ctx?.waitUntil(runMonitor(env, { force: true }));
    return json({ saved: true, revision: nextRevision, updatedAt, configurationChanged, verificationQueued });
  } catch (error) {
    const message = error instanceof Error ? error.message : "云端状态保存失败";
    const migrationMissing = /no such table|no such column/i.test(message);
    return json({ error: migrationMissing ? "D1 迁移未完成，请先应用最新 migrations" : message }, migrationMissing ? 503 : 400);
  }
}

async function handleAppState(request, env) {
  if (!env.DB) return json({ error: "未配置 D1 数据库绑定" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try { return json(await readAppState(env)); }
  catch (error) {
    const message = error instanceof Error ? error.message : "云端状态读取失败";
    const migrationMissing = /no such table|no such column/i.test(message);
    return json({ error: migrationMissing ? "D1 迁移未完成，请先应用最新 migrations" : message }, migrationMissing ? 503 : 500);
  }
}

function tokensMatch(actual, expected) {
  const left = new TextEncoder().encode(String(actual || ""));
  const right = new TextEncoder().encode(String(expected || ""));
  let difference = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) difference |= (left[index] || 0) ^ (right[index] || 0);
  return difference === 0;
}

function hasValidAdminToken(request, env) {
  return Boolean(env.ADMIN_TOKEN) && tokensMatch(request.headers.get("x-admin-token"), env.ADMIN_TOKEN);
}

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

async function monitorStatus(env) {
  if (!env.DB) return { backgroundMonitorSupported: false, ruleCount: 0, interval: 5, updatedAt: null, databaseConfigured: false, migrationsApplied: false, lastRunAt: null, lastSuccessAt: null, lastSuccessCount: 0, readyNotifiedAt: null };
  const config = await env.DB.prepare("SELECT interval_minutes, updated_at, last_run_at, last_success_at, last_success_count, ready_notified_at FROM monitor_config WHERE id = 1").first();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM monitor_rules").first();
  return {
    backgroundMonitorSupported: true,
    ruleCount: Number(count?.count || 0),
    interval: normalizeInterval(config?.interval_minutes),
    updatedAt: config?.updated_at || null,
    databaseConfigured: true,
    migrationsApplied: true,
    lastRunAt: config?.last_run_at || null,
    lastSuccessAt: config?.last_success_at || null,
    lastSuccessCount: Number(config?.last_success_count || 0),
    readyNotifiedAt: config?.ready_notified_at || null
  };
}

async function saveMonitorConfig(request, env, ctx) {
  if (!isSameOrigin(request)) return json({ error: "仅允许同源页面更新后台监控" }, 403);
  if (!env.DB) return json({ error: "未配置 D1 数据库绑定" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try {
    const body = await request.json();
    const rules = normalizeRules(body.rules);
    const interval = normalizeInterval(body.interval);
    const updatedAt = new Date().toISOString();
    const fingerprint = configFingerprint(interval, rules);
    const previous = await env.DB.prepare("SELECT config_hash FROM monitor_config WHERE id = 1").first();
    const configurationChanged = previous?.config_hash !== fingerprint;
    const statements = [
      env.DB.prepare("INSERT INTO monitor_config (id, interval_minutes, updated_at, last_run_at, config_hash, last_success_at, last_success_count, ready_notified_at) VALUES (1, ?, ?, NULL, ?, NULL, 0, NULL) ON CONFLICT(id) DO UPDATE SET interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at, last_run_at = CASE WHEN monitor_config.config_hash = excluded.config_hash THEN monitor_config.last_run_at ELSE NULL END, config_hash = excluded.config_hash, ready_notified_at = CASE WHEN monitor_config.config_hash = excluded.config_hash THEN monitor_config.ready_notified_at ELSE NULL END").bind(interval, updatedAt, fingerprint),
      env.DB.prepare("DELETE FROM monitor_rules")
    ];
    for (const rule of rules) {
      statements.push(env.DB.prepare("INSERT INTO monitor_rules (rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(rule.id, rule.shopName, rule.shopUrl, rule.token, rule.productKey, rule.productName, Number(rule.notifyRecovery)));
    }
    await env.DB.batch(statements);
    const verificationQueued = configurationChanged && rules.length > 0;
    if (verificationQueued) ctx?.waitUntil(runMonitor(env, { force: true }));
    return json({ saved: true, configurationChanged, verificationQueued, ...(await monitorStatus(env)) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "后台监控配置保存失败" }, 400);
  }
}

function notificationStatus(env) {
  return {
    channels: {
      feishu: Boolean(env.FEISHU_WEBHOOK),
      qq: Boolean(env.QQ_WEBHOOK),
      telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      dingtalk: Boolean(env.DINGTALK_WEBHOOK),
      wecom: Boolean(env.WECOM_WEBHOOK)
    },
    webConfigSupported: false,
    backgroundMonitorSupported: Boolean(env.DB),
    setupRequired: false,
    deploymentMode: "worker"
  };
}

async function deliver(channel, url, body) {
  try {
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    return { channel, ok: result.ok, status: result.status };
  } catch (error) {
    return { channel, ok: false, error: error instanceof Error ? error.message : "投递失败" };
  }
}

async function notifyAll(env, text) {
  const tasks = [];
  if (env.FEISHU_WEBHOOK) tasks.push(deliver("feishu", env.FEISHU_WEBHOOK, { msg_type: "text", content: { text } }));
  if (env.QQ_WEBHOOK) tasks.push(deliver("qq", env.QQ_WEBHOOK, { msg_type: "text", content: text, message: text }));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) tasks.push(deliver("telegram", `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text }));
  if (env.DINGTALK_WEBHOOK) tasks.push(deliver("dingtalk", env.DINGTALK_WEBHOOK, { msgtype: "text", text: { content: text } }));
  if (env.WECOM_WEBHOOK) tasks.push(deliver("wecom", env.WECOM_WEBHOOK, { msgtype: "text", text: { content: text } }));
  const results = await Promise.all(tasks);
  return { sent: results.some(result => result.ok), configured: results.length, results };
}

async function recordNotificationResults(env, text, results, shopId = null) {
  if (!env.DB || !results.length) return;
  const createdAt = new Date().toISOString();
  const statements = results.map(result => env.DB.prepare("INSERT INTO notification_log (shop_id, channel, message, success, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(shopId, result.channel, text, Number(result.ok), result.status || null, createdAt));
  statements.push(env.DB.prepare("UPDATE app_config SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(createdAt));
  await env.DB.batch(statements);
}

async function handleNotify(request, env) {
  if (!isSameOrigin(request)) return json({ error: "仅允许同源页面发送通知" }, 403);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try {
    const body = await request.json();
    const text = String(body.text || `库存事件：${body.product || "商品"}，当前库存 ${body.stock ?? 0}`).slice(0, 2000);
    const result = await notifyAll(env, text);
    await recordNotificationResults(env, text, result.results, optionalText(body.shopId, 120) || null);
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "通知发送失败" }, 400);
  }
}

async function runLegacyMonitor(env, health, { force = false } = {}) {
  if (!health) return;
  const now = new Date();
  const claimed = force
    ? await env.DB.prepare("UPDATE monitor_config SET last_run_at = ? WHERE id = 1").bind(now.toISOString()).run()
    : await env.DB.prepare("UPDATE monitor_config SET last_run_at = ? WHERE id = 1 AND (last_run_at IS NULL OR last_run_at <= ?)").bind(now.toISOString(), new Date(now.getTime() - normalizeInterval(health.interval_minutes) * 60 * 1000).toISOString()).run();
  if (!Number(claimed.meta?.changes || 0)) return;
  const rules = await env.DB.prepare("SELECT rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery FROM monitor_rules").all();
  let successfulRules = 0;
  for (const rule of rules.results || []) {
    try {
      const data = await fetchStockData(rule.shop_token, rule.shop_url, env);
      const product = data.products.find(item => item.id === rule.product_key || item.name === rule.product_name);
      if (!product) continue;
      successfulRules += 1;
      const previous = await env.DB.prepare("SELECT stock FROM monitor_state WHERE rule_id = ?").bind(rule.rule_id).first();
      const priorStock = previous ? Number(previous.stock) : null;
      const checkedAt = new Date().toISOString();
      await env.DB.prepare("INSERT INTO monitor_state (rule_id, stock, updated_at) VALUES (?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at").bind(rule.rule_id, product.stock, checkedAt).run();
      if (priorStock === null || priorStock === product.stock || (product.stock !== 0 && (!rule.notify_recovery || priorStock !== 0))) continue;
      const status = product.stock === 0 ? "库存为 0" : `库存恢复至 ${product.stock}`;
      await notifyAll(env, `${rule.shop_name}：${product.name}，${status}`);
    } catch (error) {
      console.error("[兼容监控] 检查失败", rule.rule_id, error instanceof Error ? error.message : error);
    }
  }
  if (successfulRules > 0) {
    const completedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE monitor_config SET last_success_at = ?, last_success_count = ? WHERE id = 1").bind(completedAt, successfulRules).run();
    if (!health.ready_notified_at) {
      const readiness = await notifyAll(env, `货架雷达 Worker 已就绪：D1 数据库连接和迁移正常，已同步 ${(rules.results || []).length} 条兼容监控规则，本次成功轮询 ${successfulRules} 条。`);
      if (readiness.sent) await env.DB.prepare("UPDATE monitor_config SET ready_notified_at = ? WHERE id = 1").bind(completedAt).run();
    }
  }
}

async function runMonitor(env, { force = false } = {}) {
  if (!env.DB) return;
  const [config, health] = await Promise.all([
    env.DB.prepare("SELECT interval_minutes, notify_recovery, notify_only_monitored FROM app_config WHERE id = 1").first(),
    env.DB.prepare("SELECT interval_minutes, ready_notified_at FROM monitor_config WHERE id = 1").first()
  ]);
  if (!config) return runLegacyMonitor(env, health, { force });
  if (!health) return;
  const now = new Date();
  const claimed = force
    ? await env.DB.prepare("UPDATE monitor_config SET last_run_at = ? WHERE id = 1").bind(now.toISOString()).run()
    : await env.DB.prepare("UPDATE monitor_config SET last_run_at = ? WHERE id = 1 AND (last_run_at IS NULL OR last_run_at <= ?)").bind(now.toISOString(), new Date(now.getTime() - normalizeInterval(config.interval_minutes) * 60 * 1000).toISOString()).run();
  if (!Number(claimed.meta?.changes || 0)) return;
  const shops = await env.DB.prepare("SELECT shop_id, name, custom_name, url, shop_token FROM shops WHERE enabled = 1 ORDER BY sort_order, shop_id").all();
  let successfulRules = 0;
  let stateChanged = false;
  for (const shop of shops.results || []) {
    try {
      const data = await fetchStockData(shop.shop_token, shop.url, env);
      const existingRows = await env.DB.prepare("SELECT product_key, name, stock, monitored, favorite, sort_order FROM products WHERE shop_id = ? ORDER BY sort_order, product_key").bind(shop.shop_id).all();
      const existingById = new Map((existingRows.results || []).map(product => [product.product_key, product]));
      const completedAt = new Date().toISOString();
      const updates = [
        env.DB.prepare("UPDATE shops SET name = CASE WHEN custom_name = 1 THEN name ELSE ? END, remote_name = ?, categories_json = ?, last_checked_at = ?, updated_at = ? WHERE shop_id = ?").bind(data.shop?.name || shop.name, data.shop?.name || null, JSON.stringify(data.categories || []), completedAt, completedAt, shop.shop_id)
      ];
      const transitions = [];
      for (const [index, product] of (data.products || []).entries()) {
        const existing = existingById.get(product.id);
        const monitored = Boolean(existing?.monitored);
        const favorite = Boolean(existing?.favorite);
        const sortOrder = existing ? Number(existing.sort_order || 0) : existingById.size + index;
        updates.push(env.DB.prepare("INSERT INTO products (shop_id, product_key, name, category, price, stock, monitored, favorite, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(shop_id, product_key) DO UPDATE SET name = excluded.name, category = excluded.category, price = excluded.price, stock = excluded.stock, updated_at = excluded.updated_at").bind(shop.shop_id, product.id, product.name, product.category, product.price, product.stock, Number(monitored), Number(favorite), sortOrder, completedAt));
        if (monitored) {
          successfulRules += 1;
          updates.push(env.DB.prepare("INSERT INTO monitor_state (rule_id, stock, updated_at) VALUES (?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at").bind(`${shop.shop_id}:${product.id}`, product.stock, completedAt));
        }
        const priorStock = existing ? Number(existing.stock) : null;
        const shouldTrack = monitored || !Boolean(config.notify_only_monitored);
        const changedAtBoundary = priorStock !== null && priorStock !== product.stock && (priorStock === 0 || product.stock === 0);
        const shouldNotify = product.stock === 0 || (priorStock === 0 && Boolean(config.notify_recovery));
        if (shouldTrack && changedAtBoundary) {
          const status = product.stock === 0 ? "库存为 0" : `库存恢复至 ${product.stock}`;
          updates.push(env.DB.prepare("INSERT INTO inventory_events (shop_id, product_key, product_name, message, tone, is_read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(shop.shop_id, product.id, product.name, status, product.stock === 0 ? "red" : "green", completedAt));
          updates.push(env.DB.prepare("INSERT INTO activity (shop_id, icon, tone, title, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(shop.shop_id, product.stock === 0 ? "!" : "↻", product.stock === 0 ? "red" : "", `${product.name} ${status}`, `${shop.name} · Worker 后台轮询`, completedAt));
          if (shouldNotify) transitions.push({ product, status });
        }
      }
      await env.DB.batch(updates);
      stateChanged = true;
      for (const transition of transitions) {
        const text = `${shop.name}：${transition.product.name}，${transition.status}`;
        const delivery = await notifyAll(env, text);
        await recordNotificationResults(env, text, delivery.results, shop.shop_id);
      }
    } catch (error) {
      console.error("[后台监控] 检查失败", shop.shop_id, error instanceof Error ? error.message : error);
    }
  }
  if (stateChanged) await env.DB.prepare("UPDATE app_config SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(new Date().toISOString()).run();
  if (successfulRules > 0) {
    const completedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE monitor_config SET last_success_at = ?, last_success_count = ? WHERE id = 1").bind(completedAt, successfulRules).run();
    if (!health.ready_notified_at) {
      const readinessText = `货架雷达 Worker 已就绪：D1 数据库连接和迁移正常，本次成功轮询 ${successfulRules} 条监控商品。`;
      const readiness = await notifyAll(env, readinessText);
      await recordNotificationResults(env, readinessText, readiness.results);
      if (readiness.sent) await env.DB.prepare("UPDATE monitor_config SET ready_notified_at = ? WHERE id = 1").bind(completedAt).run();
    }
  }
}

async function handleStock(request, url, env) {
  if (env.ADMIN_TOKEN && !hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  const token = url.searchParams.get("token") || url.searchParams.get("shop");
  if (!token || !/^[A-Za-z0-9]+$/.test(token)) return json({ error: "缺少有效的店铺 token" }, 400);
  try {
    return json(await fetchStockData(token, url.searchParams.get("url"), env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const clientError = /未配置|店铺链接|不允许|仅启用/.test(message);
    return json({ error: clientError ? message : "店铺接口暂时不可用", ...(clientError ? {} : { detail: message }) }, clientError ? 400 : 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, 204);
    if (url.pathname === "/api/stock" && request.method === "GET") return handleStock(request, url, env);
    if (url.pathname === "/api/app-state" && request.method === "GET") return handleAppState(request, env);
    if (url.pathname === "/api/app-state" && request.method === "POST") return saveAppState(request, env, ctx);
    if (url.pathname === "/api/notify" && request.method === "GET") return json(notificationStatus(env));
    if (url.pathname === "/api/notify" && request.method === "POST") return handleNotify(request, env);
    if (url.pathname === "/api/monitor-config" && request.method === "GET") return json(await monitorStatus(env));
    if (url.pathname === "/api/monitor-config" && request.method === "POST") return saveMonitorConfig(request, env, ctx);
    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    if (!STATIC_PATHS.has(url.pathname)) return new Response("Not Found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  }
};
