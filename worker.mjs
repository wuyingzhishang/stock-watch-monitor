const STATIC_PATHS = new Set(["/", "/index.html", "/styles.css", "/state-store.js", "/app.js"]);
const MAX_RULES = 100;

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
  if (!env.DB) return { backgroundMonitorSupported: false, ruleCount: 0, interval: 5, updatedAt: null, databaseConfigured: false };
  const config = await env.DB.prepare("SELECT interval_minutes, updated_at FROM monitor_config WHERE id = 1").first();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM monitor_rules").first();
  return {
    backgroundMonitorSupported: true,
    ruleCount: Number(count?.count || 0),
    interval: normalizeInterval(config?.interval_minutes),
    updatedAt: config?.updated_at || null,
    databaseConfigured: true
  };
}

async function saveMonitorConfig(request, env) {
  if (!isSameOrigin(request)) return json({ error: "仅允许同源页面更新后台监控" }, 403);
  if (!env.DB) return json({ error: "未配置 D1 数据库绑定" }, 503);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try {
    const body = await request.json();
    const rules = normalizeRules(body.rules);
    const interval = normalizeInterval(body.interval);
    const updatedAt = new Date().toISOString();
    const statements = [
      env.DB.prepare("INSERT INTO monitor_config (id, interval_minutes, updated_at, last_run_at) VALUES (1, ?, ?, NULL) ON CONFLICT(id) DO UPDATE SET interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at, last_run_at = NULL").bind(interval, updatedAt),
      env.DB.prepare("DELETE FROM monitor_rules")
    ];
    for (const rule of rules) {
      statements.push(env.DB.prepare("INSERT INTO monitor_rules (rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(rule.id, rule.shopName, rule.shopUrl, rule.token, rule.productKey, rule.productName, Number(rule.notifyRecovery)));
    }
    await env.DB.batch(statements);
    return json({ saved: true, ...(await monitorStatus(env)) });
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
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

async function handleNotify(request, env) {
  if (!isSameOrigin(request)) return json({ error: "仅允许同源页面发送通知" }, 403);
  if (!env.ADMIN_TOKEN) return json({ error: "未配置 ADMIN_TOKEN Secret" }, 503);
  if (!hasValidAdminToken(request, env)) return json({ error: "管理口令无效" }, 401);
  try {
    const body = await request.json();
    const text = String(body.text || `库存事件：${body.product || "商品"}，当前库存 ${body.stock ?? 0}`).slice(0, 2000);
    return json(await notifyAll(env, text));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "通知发送失败" }, 400);
  }
}

async function runMonitor(env) {
  if (!env.DB) return;
  const config = await env.DB.prepare("SELECT interval_minutes FROM monitor_config WHERE id = 1").first();
  if (!config) return;
  const now = new Date();
  const dueBefore = new Date(now.getTime() - normalizeInterval(config.interval_minutes) * 60 * 1000).toISOString();
  const claimed = await env.DB.prepare("UPDATE monitor_config SET last_run_at = ? WHERE id = 1 AND (last_run_at IS NULL OR last_run_at <= ?)").bind(now.toISOString(), dueBefore).run();
  if (!Number(claimed.meta?.changes || 0)) return;
  const rules = await env.DB.prepare("SELECT rule_id, shop_name, shop_url, shop_token, product_key, product_name, notify_recovery FROM monitor_rules").all();
  for (const rule of rules.results || []) {
    try {
      const data = await fetchStockData(rule.shop_token, rule.shop_url, env);
      const product = data.products.find(item => item.id === rule.product_key || item.name === rule.product_name);
      if (!product) continue;
      const previous = await env.DB.prepare("SELECT stock FROM monitor_state WHERE rule_id = ?").bind(rule.rule_id).first();
      const priorStock = previous ? Number(previous.stock) : null;
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO monitor_state (rule_id, stock, updated_at) VALUES (?, ?, ?) ON CONFLICT(rule_id) DO UPDATE SET stock = excluded.stock, updated_at = excluded.updated_at").bind(rule.rule_id, product.stock, now).run();
      if (priorStock === null || priorStock === product.stock || (product.stock !== 0 && (!rule.notify_recovery || priorStock !== 0))) continue;
      const status = product.stock === 0 ? "库存为 0" : `库存恢复至 ${product.stock}`;
      await notifyAll(env, `${rule.shop_name}：${product.name}，${status}`);
    } catch (error) {
      console.error("[后台监控] 检查失败", rule.rule_id, error instanceof Error ? error.message : error);
    }
  }
}

async function handleStock(url, env) {
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({}, 204);
    if (url.pathname === "/api/stock" && request.method === "GET") return handleStock(url, env);
    if (url.pathname === "/api/notify" && request.method === "GET") return json(notificationStatus(env));
    if (url.pathname === "/api/notify" && request.method === "POST") return handleNotify(request, env);
    if (url.pathname === "/api/monitor-config" && request.method === "GET") return json(await monitorStatus(env));
    if (url.pathname === "/api/monitor-config" && request.method === "POST") return saveMonitorConfig(request, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "接口不存在" }, 404);
    if (!STATIC_PATHS.has(url.pathname)) return new Response("Not Found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  }
};
