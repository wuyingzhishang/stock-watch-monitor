const seedProducts = [
  { id: "demo-basic", name: "示例商品：云服务基础版", category: "订阅服务", price: 19.9, stock: 0, monitored: true, favorite: true },
  { id: "demo-pro", name: "示例商品：云服务专业版", category: "订阅服务", price: 49.9, stock: 18, monitored: false, favorite: false },
  { id: "demo-storage", name: "示例商品：存储扩展包", category: "增值服务", price: 9.9, stock: 4, monitored: false, favorite: false },
  { id: "demo-support", name: "示例商品：技术支持服务", category: "增值服务", price: 29.9, stock: 32, monitored: false, favorite: false },
  { id: "demo-license", name: "示例商品：团队授权许可", category: "数字商品", price: 99, stock: 7, monitored: false, favorite: true }
];

const channelDefinitions = [
  { id: "feishu", name: "飞书机器人", type: "feishu", env: "FEISHU_WEBHOOK" },
  { id: "qq", name: "QQ 机器人", type: "qq", env: "QQ_WEBHOOK" },
  { id: "telegram", name: "Telegram Bot", type: "telegram", env: "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID" },
  { id: "dingtalk", name: "钉钉机器人", type: "dingtalk", env: "DINGTALK_WEBHOOK" },
  { id: "wecom", name: "企业微信机器人", type: "wecom", env: "WECOM_WEBHOOK" }
];

const channelFieldMap = {
  feishu: [{ key: "FEISHU_WEBHOOK", label: "飞书 Webhook", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." }],
  qq: [{ key: "QQ_WEBHOOK", label: "QQ 机器人 Webhook", placeholder: "https://example.com/qq-webhook" }],
  telegram: [{ key: "TELEGRAM_BOT_TOKEN", label: "Bot Token", placeholder: "123456:ABC..." }, { key: "TELEGRAM_CHAT_ID", label: "Chat ID", placeholder: "例如 -1001234567890" }],
  dingtalk: [{ key: "DINGTALK_WEBHOOK", label: "钉钉 Webhook", placeholder: "https://oapi.dingtalk.com/robot/send?..." }],
  wecom: [{ key: "WECOM_WEBHOOK", label: "企业微信 Webhook", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?..." }]
};

const defaultState = {
  schemaVersion: 4,
  shops: [{ id: "shop-demo001", name: "示例店铺", customName: true, url: "https://demo.example.com/shop/DEMO001", token: "DEMO001", note: "开源演示数据", enabled: true, favorite: true, lastChecked: Date.now(), categories: ["订阅服务", "增值服务", "数字商品"], products: seedProducts }],
  selectedShopId: "shop-demo001",
  interval: 5,
  keepLastStock: true,
  notifyRecovery: true,
  notifyOnlyMonitored: true,
  channels: channelDefinitions.map(channel => ({ ...channel, connected: false })),
  activity: [{ icon: "!", tone: "red", title: "示例商品：云服务基础版 库存为 0", meta: "示例店铺 · 当前状态", shopId: "shop-demo001" }],
  events: [],
  notificationLog: []
};

let state = JSON.parse(JSON.stringify(defaultState));
let selectedCategory = "all";
let refreshTimer;
let cloudSaveTimer;
let cloudSaveInFlight = false;
let cloudSavePending = false;
let cloudRevision = 0;
let cloudInitialized = false;
let legacyMigrationPending = false;
let adminNoticeShown = false;
let activeChannelId = null;
let sessionAdminToken = "";
let notificationCapabilities = { webConfigSupported: false, backgroundMonitorSupported: false, setupRequired: false };
let deploymentMode = "worker";
const shopRefreshControllers = new Map();

function normalizeClientState(input) {
  const loaded = input && typeof input === "object" ? { ...defaultState, ...input } : { ...defaultState };
  loaded.schemaVersion = 4;
  loaded.shops = Array.isArray(loaded.shops) ? loaded.shops.map(shop => ({ ...shop, customName: shop.customName ?? true, products: Array.isArray(shop.products) ? shop.products : [] })) : [];
  if (!loaded.shops.some(shop => shop.id === loaded.selectedShopId)) loaded.selectedShopId = loaded.shops[0]?.id || null;
  loaded.activity = Array.isArray(loaded.activity) ? loaded.activity : [];
  loaded.events = Array.isArray(loaded.events) ? loaded.events : [];
  loaded.notificationLog = Array.isArray(loaded.notificationLog) ? loaded.notificationLog : [];
  loaded.channels = channelDefinitions.map(channel => ({ ...channel, connected: false }));
  return loaded;
}

function readLegacyState() {
  try {
    const raw = localStorage.getItem("stock-watch-monitor");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Number(parsed.schemaVersion || 0) >= 3 && Array.isArray(parsed.shops) ? normalizeClientState(parsed) : null;
  } catch { return null; }
}

async function loadCloudState({ silent = false } = {}) {
  try {
    const headers = { accept: "application/json" };
    if (sessionAdminToken) headers["x-admin-token"] = sessionAdminToken;
    const response = await fetch("./api/app-state", { headers, cache: "no-store" });
    const payload = await response.json();
    if (response.status === 401) {
      sessionAdminToken = "";
      openModal("cloudLoginModal");
    }
    if (!response.ok) throw new Error(payload.error || "服务端数据读取失败");
    cloudRevision = Number(payload.revision || 0);
    cloudInitialized = Boolean(payload.initialized);
    const legacy = !cloudInitialized ? readLegacyState() : null;
    state = normalizeClientState(legacy || payload.state);
    legacyMigrationPending = Boolean(legacy);
    if (!silent && legacyMigrationPending) toast("已读取旧数据，请在系统设置输入管理口令完成迁移");
    return true;
  } catch (error) {
    state = normalizeClientState(defaultState);
    if (!silent) toast(error.message || "无法读取服务端数据");
    return false;
  }
}

async function persistCloudState(showToast = false) {
  if (!sessionAdminToken) {
    cloudSavePending = true;
    if (!adminNoticeShown || showToast) toast("数据尚未保存：请在系统设置输入服务端管理口令");
    adminNoticeShown = true;
    return false;
  }
  if (cloudSaveInFlight) { cloudSavePending = true; return false; }
  cloudSaveInFlight = true;
  cloudSavePending = false;
  try {
    const response = await fetch("./api/app-state", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": sessionAdminToken },
      body: JSON.stringify({ revision: cloudRevision, state })
    });
    const payload = await response.json();
    if (response.status === 401) {
      sessionAdminToken = "";
      openModal("cloudLoginModal");
    }
    if (response.status === 409) {
      await loadCloudState({ silent: true });
      renderAll();
      throw new Error("服务端数据已由后台更新，页面已重新加载");
    }
    if (!response.ok) throw new Error(payload.error || "服务端保存失败");
    cloudRevision = Number(payload.revision || cloudRevision + 1);
    cloudInitialized = true;
    if (legacyMigrationPending) {
      localStorage.removeItem("stock-watch-monitor");
      legacyMigrationPending = false;
    }
    if (showToast) toast(payload.verificationQueued ? "已保存到服务端，正在验证后台轮询" : "已保存到服务端");
    return true;
  } catch (error) {
    if (showToast || !adminNoticeShown) toast(error.message || "服务端保存失败");
    console.warn("服务端状态保存失败", error);
    return false;
  } finally {
    cloudSaveInFlight = false;
    if (cloudSavePending && sessionAdminToken) {
      window.clearTimeout(cloudSaveTimer);
      cloudSaveTimer = window.setTimeout(() => persistCloudState(), 300);
    }
  }
}

function saveState(showToast = false) {
  cloudSavePending = true;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(() => persistCloudState(showToast), 450);
}
function currentShop() { return state.shops.find(shop => shop.id === state.selectedShopId) || state.shops[0]; }
function renderNoShopState() { document.getElementById("productPanelTitle").textContent = "请选择或添加店铺"; document.getElementById("categoryFilter").innerHTML = `<option value="all">全部分类</option>`; document.getElementById("categoryChips").innerHTML = ""; document.getElementById("productTableBody").innerHTML = `<tr><td colspan="7"><div class="empty-state">添加店铺后即可查询商品和库存</div></td></tr>`; }
function fmtPrice(price) { return Number(price || 0).toFixed(2).replace(/\.00$/, ""); }
function stockMeta(stock) { if (stock === 0) return { label: "缺货", cls: "out" }; if (stock <= 5) return { label: `剩余 ${stock} 件`, cls: "low" }; return { label: stock >= 20 ? "库存充足" : `剩余 ${stock} 件`, cls: "ok" }; }
function relativeTime(timestamp) { const diff = Math.max(0, Date.now() - timestamp); const mins = Math.floor(diff / 60000); if (mins < 1) return "刚刚"; if (mins < 60) return `${mins} 分钟前`; return `${Math.floor(mins / 60)} 小时前`; }
function recordTime(value) { const timestamp = typeof value === "number" ? value : Date.parse(value || ""); return Number.isFinite(timestamp) ? relativeTime(timestamp) : String(value || "刚刚"); }
function toast(message) { const el = document.getElementById("toast"); el.textContent = message; el.classList.add("show"); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove("show"), 2600); }
function addActivity(title, meta, tone = "", shopId = null) { state.activity.unshift({ icon: tone === "red" ? "!" : "↻", tone, title, meta, shopId, createdAt: new Date().toISOString() }); state.activity = state.activity.slice(0, 100); }

function renderAll() { renderStats(); renderOverviewTable(); renderActivity(); renderShops(); renderShopList(); renderProducts(); if (!currentShop()) renderNoShopState(); renderRules(); renderEvents(); renderChannels(); renderNotificationLog(); renderSettings(); }
function renderStats() {
  const products = state.shops.flatMap(shop => shop.products || []); const monitored = products.filter(product => product.monitored); const out = monitored.filter(product => product.stock === 0);
  const latestCheck = state.shops.length ? Math.max(...state.shops.map(shop => shop.lastChecked || 0)) : 0;
  const backgroundLabel = deploymentMode === "worker" ? "Worker 后台轮询运行中" : `${deploymentMode === "docker" ? "Docker" : "Node"} 后台轮询运行中`;
  document.getElementById("statShops").textContent = state.shops.length; document.getElementById("statMonitors").textContent = monitored.length; document.getElementById("statOutOfStock").textContent = out.length; document.getElementById("statChannels").textContent = state.channels.filter(channel => channel.connected).length; document.getElementById("navMonitorCount").textContent = monitored.length; document.getElementById("pollingStatusLabel").textContent = state.shops.length ? (notificationCapabilities.backgroundMonitorSupported ? backgroundLabel : "页面轮询运行中") : "暂无监控店铺"; document.getElementById("sidebarLastCheck").textContent = latestCheck ? relativeTime(latestCheck) : "暂无"; document.getElementById("lastSync").textContent = latestCheck ? relativeTime(latestCheck) : "暂无";
}
function productRow(product, shop) { const stock = stockMeta(product.stock); return `<tr><td><div class="product-name">${escapeHtml(product.name)}<span class="product-shop">${escapeHtml(shop.name)}</span></div></td><td><span class="category-tag">${escapeHtml(product.category)}</span></td><td><span class="stock-badge ${stock.cls}">${stock.label}</span></td><td><span class="muted">¥${fmtPrice(product.price)}</span></td><td><label class="switch"><input type="checkbox" data-monitor="${product.id}" ${product.monitored ? "checked" : ""}><span class="switch-track"></span></label></td><td><button class="small-action" data-focus-product="${product.id}">详情</button></td></tr>`; }
function renderOverviewTable() { const rows = state.shops.flatMap(shop => (shop.products || []).filter(product => product.monitored).map(product => productRow(product, shop))); document.getElementById("monitorTableBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="6"><div class="empty-state">还没有重点监控商品</div></td></tr>`; }
function renderActivity() { document.getElementById("activityList").innerHTML = state.activity.length ? state.activity.map(item => `<div class="activity-item"><div class="activity-icon ${item.tone || ""}">${item.icon}</div><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></div></div>`).join("") : `<div class="empty-state">暂无动态</div>`; }
function renderShops() { document.getElementById("shopGrid").innerHTML = state.shops.length ? state.shops.map((shop, index) => `<article class="shop-card"><div class="shop-card-top"><div class="shop-avatar">${escapeHtml(shop.name.slice(0, 1))}</div><button class="priority-star ${shop.favorite ? "active" : ""}" data-favorite-shop="${shop.id}" title="收藏店铺">★</button></div><div><h4>${escapeHtml(shop.name)}</h4><p>${escapeHtml(shop.note || "未填写备注")}</p></div><div class="shop-meta"><span>${(shop.products || []).length} 件商品</span><span>${(shop.products || []).filter(product => product.stock === 0).length} 件缺货</span></div><a class="shop-link" href="${escapeAttr(shop.url)}" target="_blank" rel="noreferrer">${escapeHtml(shop.url)}</a><div class="shop-card-actions"><div class="order-actions"><button class="move-button" data-move-shop="${shop.id}" data-direction="-1" title="上移店铺" ${index === 0 ? "disabled" : ""}>↑</button><button class="move-button" data-move-shop="${shop.id}" data-direction="1" title="下移店铺" ${index === state.shops.length - 1 ? "disabled" : ""}>↓</button></div><button class="danger-text-button" data-delete-shop="${shop.id}">删除店铺</button></div></article>`).join("") : `<div class="empty-state shop-empty">还没有店铺，点击“添加店铺”开始监控。</div>`; }
function renderShopList() { document.getElementById("shopCountLabel").textContent = `${state.shops.length} 个店铺`; document.getElementById("shopList").innerHTML = state.shops.length ? state.shops.map((shop, index) => `<div class="shop-list-item ${shop.id === state.selectedShopId ? "active" : ""}" data-select-shop="${shop.id}"><div class="shop-list-item-top"><div class="shop-avatar">${escapeHtml(shop.name.slice(0, 1))}</div><h4>${escapeHtml(shop.name)}</h4><span class="mini-status"></span><div class="order-actions"><button class="move-button" data-move-shop="${shop.id}" data-direction="-1" title="上移店铺" ${index === 0 ? "disabled" : ""}>↑</button><button class="move-button" data-move-shop="${shop.id}" data-direction="1" title="下移店铺" ${index === state.shops.length - 1 ? "disabled" : ""}>↓</button></div><button class="shop-list-delete" data-delete-shop="${shop.id}" title="删除店铺">×</button></div><p>${(shop.products || []).length} 件商品 · ${relativeTime(shop.lastChecked || Date.now())}</p></div>`).join("") : `<div class="empty-state">暂无店铺</div>`; }
function renderProducts() { const shop = currentShop(); if (!shop) return; document.getElementById("productPanelTitle").textContent = shop.name; const categoryFilter = document.getElementById("categoryFilter"); const categories = [...new Set((shop.products || []).map(product => product.category))]; categoryFilter.innerHTML = `<option value="all">全部分类</option>${categories.map(category => `<option value="${escapeAttr(category)}">${escapeHtml(category)}</option>`).join("")}`; categoryFilter.value = selectedCategory === "all" || categories.includes(selectedCategory) ? selectedCategory : "all"; document.getElementById("categoryChips").innerHTML = ["all", ...categories].map(category => `<button class="category-chip ${selectedCategory === category ? "active" : ""}" data-category="${escapeAttr(category)}">${category === "all" ? "全部" : escapeHtml(category)}</button>`).join(""); const search = (document.getElementById("productSearch").value || "").trim().toLowerCase(); const stockFilter = document.getElementById("stockFilter").value; const filtered = (shop.products || []).filter(product => { const matchSearch = !search || product.name.toLowerCase().includes(search); const matchCategory = selectedCategory === "all" || product.category === selectedCategory; const matchStock = stockFilter === "all" || (stockFilter === "out" && product.stock === 0) || (stockFilter === "low" && product.stock <= 5) || (stockFilter === "in" && product.stock > 0); return matchSearch && matchCategory && matchStock; }); document.getElementById("productTableBody").innerHTML = filtered.map(product => { const stock = stockMeta(product.stock); const index = shop.products.findIndex(item => item.id === product.id); return `<tr><td class="drag-col"><div class="order-actions"><button class="move-button" data-move-product="${product.id}" data-direction="-1" title="上移商品" ${index === 0 ? "disabled" : ""}>↑</button><button class="move-button" data-move-product="${product.id}" data-direction="1" title="下移商品" ${index === shop.products.length - 1 ? "disabled" : ""}>↓</button></div></td><td><div class="product-name">${escapeHtml(product.name)}</div></td><td><span class="category-tag">${escapeHtml(product.category)}</span></td><td>¥${fmtPrice(product.price)}</td><td><span class="stock-badge ${stock.cls}">${stock.label}</span></td><td><button class="priority-star ${product.favorite ? "active" : ""}" data-favorite-product="${product.id}" title="收藏商品">★</button></td><td><label class="switch"><input type="checkbox" data-monitor="${product.id}" ${product.monitored ? "checked" : ""}><span class="switch-track"></span></label></td></tr>`; }).join("") || `<tr><td colspan="7"><div class="empty-state">没有匹配的商品</div></td></tr>`; }
function renderRules() { const monitored = state.shops.flatMap(shop => (shop.products || []).filter(product => product.monitored).map(product => ({ ...product, shopName: shop.name }))); document.getElementById("monitorRuleCount").textContent = monitored.length; document.getElementById("rule-list"); document.getElementById("monitorRuleList").innerHTML = monitored.length ? monitored.map(product => `<div class="rule-item"><div class="rule-badge">!</div><div class="rule-item-main"><h4>${escapeHtml(product.name)}</h4><p>${escapeHtml(product.shopName)} · 库存为 0 时通知 · 每 ${state.interval} 分钟检查</p></div><label class="switch"><input type="checkbox" data-monitor="${product.id}" checked><span class="switch-track"></span></label></div>`).join("") : `<div class="empty-state">暂无监控规则</div>`; }
function renderEvents() { document.getElementById("eventList").innerHTML = state.events.length ? state.events.map(event => `<div class="event-item ${event.read ? "read" : ""}"><span class="event-time">${escapeHtml(recordTime(event.createdAt || event.time))}</span><span class="event-dot" style="background:${event.tone === "green" ? "var(--green)" : "var(--red)"}"></span><div><strong>${escapeHtml(event.product)}</strong><small>${escapeHtml(event.text)}</small></div></div>`).join("") : `<div class="empty-state">暂无库存事件</div>`; }
function renderChannels() { const logos = { feishu: "飞", qq: "Q", telegram: "T", dingtalk: "钉", wecom: "企" }; document.getElementById("channelGrid").innerHTML = state.channels.map(channel => `<article class="channel-card"><div class="channel-card-top"><div class="channel-brand"><span class="channel-logo ${channel.type}">${logos[channel.type] || "N"}</span>${escapeHtml(channel.name)}</div><button class="small-action" ${notificationCapabilities.webConfigSupported ? `data-channel-config="${channel.id}"` : `data-channel-refresh="${channel.id}"`} title="${notificationCapabilities.webConfigSupported ? "配置渠道" : "刷新渠道状态"}">${notificationCapabilities.webConfigSupported ? "配置" : "刷新"}</button></div><small>${channel.connected ? "服务端配置已生效" : `待配置 ${escapeHtml(channel.env)}`}</small><div class="channel-state"><span>状态</span><strong class="${channel.connected ? "" : "offline"}">${channel.connected ? "已连接" : "未配置"}</strong></div></article>`).join(""); }
function renderNotificationLog() { const channelNames = new Map(channelDefinitions.map(channel => [channel.id, channel.name])); document.getElementById("notificationLog").innerHTML = state.notificationLog.length ? state.notificationLog.map(item => `<div class="notification-log-item"><div><strong>${escapeHtml(channelNames.get(item.channel) || item.channel)}</strong><small>${escapeHtml(item.text)}</small></div><span class="muted">${escapeHtml(recordTime(item.createdAt || item.time))}</span></div>`).join("") : `<div class="empty-state">暂无通知记录</div>`; }
function renderSettings() { document.getElementById("pollInterval").value = String(state.interval); document.getElementById("settingsInterval").value = String(state.interval); document.getElementById("keepLastStock").checked = state.keepLastStock; document.getElementById("notifyRecovery").checked = state.notifyRecovery; document.getElementById("notifyOnlyMonitored").checked = state.notifyOnlyMonitored; document.getElementById("workerAdminToken").placeholder = sessionAdminToken ? "当前会话已验证" : "仅本次会话使用"; }
function renderDeploymentMode() { const modes = { docker: { label: "Docker 版", cls: "docker" }, worker: { label: "Worker + D1", cls: "cloudflare" }, cloudflare: { label: "Cloudflare 版", cls: "cloudflare" }, node: { label: "Node 版", cls: "node" }, static: { label: "静态演示", cls: "" } }; const mode = modes[deploymentMode] || modes.node; const badge = document.getElementById("deploymentModeBadge"); badge.textContent = mode.label; badge.className = `runtime-badge ${mode.cls}`.trim(); }

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
function findProduct(productId) { for (const shop of state.shops) { const product = (shop.products || []).find(item => item.id === productId); if (product) return { shop, product }; } return null; }
function toggleMonitor(productId, checked) { const result = findProduct(productId); if (!result) return; result.product.monitored = checked; if (checked && result.product.stock === 0) { addActivity(`${result.product.name} 已加入缺货监控`, `${result.shop.name} · 刚刚`, "", result.shop.id); } saveState(); renderAll(); toast(checked ? "已加入重点监控" : "已移出重点监控"); }
function moveItem(items, id, direction) { const index = items.findIndex(item => item.id === id); const target = index + Number(direction); if (index < 0 || target < 0 || target >= items.length) return false; [items[index], items[target]] = [items[target], items[index]]; return true; }

async function sendNotification(text, product, shop) {
  const response = await fetch("./api/notify", { method: "POST", headers: { "content-type": "application/json", "x-admin-token": sessionAdminToken }, body: JSON.stringify({ text, product: product?.name || product, shop: shop?.name || shop, shopId: shop?.id || null, stock: product?.stock }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "通知发送失败");
  return result;
}

async function refreshChannelStatus(showToast = false) {
  try {
    const response = await fetch("./api/notify", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("状态读取失败");
    const payload = await response.json();
    notificationCapabilities = { webConfigSupported: Boolean(payload.webConfigSupported), backgroundMonitorSupported: Boolean(payload.backgroundMonitorSupported), setupRequired: Boolean(payload.setupRequired) };
    deploymentMode = payload.deploymentMode || "node";
    state.channels = channelDefinitions.map(channel => ({ ...channel, connected: Boolean(payload.channels?.[channel.id]) }));
    renderChannels(); renderStats(); renderDeploymentMode();
    if (showToast) toast("通知渠道状态已刷新");
  } catch {
    deploymentMode = "static";
    state.channels = channelDefinitions.map(channel => ({ ...channel, connected: false }));
    renderChannels(); renderStats(); renderDeploymentMode();
    if (showToast) toast("无法读取通知渠道状态");
  }
}

function openChannelConfig(channelId) {
  if (!notificationCapabilities.webConfigSupported) return toast("请在部署平台的 Secrets 或环境变量中配置通知渠道");
  const channel = state.channels.find(item => item.id === channelId);
  if (!channel) return;
  activeChannelId = channelId;
  document.getElementById("channelModalTitle").textContent = `配置${channel.name}`;
  document.getElementById("channelFields").innerHTML = (channelFieldMap[channelId] || []).map(field => `<label class="field-label" for="config-${field.key}">${escapeHtml(field.label)}</label><input id="config-${field.key}" class="full-input" type="password" autocomplete="off" placeholder="${escapeAttr(field.placeholder)}" data-config-key="${field.key}" />`).join("");
  const adminInput = document.getElementById("channelAdminToken");
  adminInput.value = "";
  adminInput.placeholder = sessionAdminToken ? "本次会话已记住，可留空" : (notificationCapabilities.setupRequired ? "首次设置，至少 8 位" : "输入管理口令");
  document.getElementById("channelAdminHint").textContent = notificationCapabilities.setupRequired ? "首次保存会创建管理口令，后续修改和清空配置都需要它。" : "管理口令仅用于本次请求，不会保存到浏览器。";
  document.getElementById("clearChannelConfig").checked = false;
  openModal("channelModal");
}

async function saveChannelConfig(event) {
  event.preventDefault();
  const adminInput = document.getElementById("channelAdminToken");
  const adminToken = adminInput.value.trim() || sessionAdminToken;
  if (!adminToken) return toast("请输入管理口令");
  const clear = document.getElementById("clearChannelConfig").checked;
  const values = Object.fromEntries([...document.querySelectorAll("#channelFields [data-config-key]")].map(input => [input.dataset.configKey, input.value.trim()]));
  const submitButton = document.getElementById("saveChannelConfigButton");
  submitButton.disabled = true;
  try {
    const response = await fetch("./api/notification-config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: activeChannelId, adminToken, setupAdmin: notificationCapabilities.setupRequired, clear, values }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "保存失败");
    sessionAdminToken = adminToken;
    notificationCapabilities = { webConfigSupported: Boolean(payload.webConfigSupported), backgroundMonitorSupported: Boolean(payload.backgroundMonitorSupported), setupRequired: Boolean(payload.setupRequired) };
    deploymentMode = payload.deploymentMode || deploymentMode;
    state.channels = channelDefinitions.map(channel => ({ ...channel, connected: Boolean(payload.channels?.[channel.id]) }));
    renderChannels(); renderStats(); renderDeploymentMode(); closeModal("channelModal"); event.target.reset();
    toast(clear ? "渠道配置已清空" : "渠道配置已保存");
  } catch (error) { toast(error.message || "渠道配置保存失败"); }
  finally { submitButton.disabled = false; }
}

async function testNotifications() {
  const button = document.getElementById("testNotificationButton");
  button.disabled = true;
  try {
    await refreshChannelStatus();
    if (!state.channels.some(channel => channel.connected)) return toast("服务端尚未配置通知渠道");
    const result = await sendNotification("货架雷达：这是一条测试通知", "测试通知", "通知中心");
    await loadCloudState({ silent: true });
    await refreshChannelStatus();
    renderAll();
    toast(result.sent ? "测试通知已发送" : "测试通知投递失败");
  } catch (error) { toast(error.message || "测试通知发送失败"); }
  finally { button.disabled = false; }
}

async function refreshShop(shop = currentShop(), silent = false) {
  if (!shop || !state.shops.some(item => item.id === shop.id)) return;
  shopRefreshControllers.get(shop.id)?.abort();
  const controller = new AbortController();
  shopRefreshControllers.set(shop.id, controller);
  if (!silent) setRefreshBusy(true);
  if (!silent) toast("正在同步库存…");
  try {
    const response = await fetch(`./api/stock?token=${encodeURIComponent(shop.token)}&url=${encodeURIComponent(shop.url)}`, { headers: { "x-admin-token": sessionAdminToken }, signal: controller.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "同步失败");
    if (!state.shops.some(item => item.id === shop.id)) return;
    const oldProducts = new Map((shop.products || []).map(product => [product.id, product]));
    const oldOrder = new Map((shop.products || []).map((product, index) => [product.id, index]));
    if (payload.shop) { shop.remoteName = payload.shop.name || shop.remoteName; if (!shop.customName) shop.name = payload.shop.name || shop.name; shop.categories = payload.categories || shop.categories; }
    if (Array.isArray(payload.products) && payload.products.length) {
      shop.products = payload.products.map((product, payloadIndex) => {
        const old = oldProducts.get(product.id);
        const next = { ...product, monitored: old?.monitored || false, favorite: old?.favorite || false, sortIndex: oldOrder.get(product.id) ?? oldOrder.size + payloadIndex };
        if (old?.monitored && old.stock !== next.stock && (old.stock === 0 || next.stock === 0)) {
          const statusText = next.stock === 0 ? "库存为 0" : `库存恢复至 ${next.stock}`;
          const createdAt = new Date().toISOString();
          state.events.unshift({ createdAt, productKey: next.id, product: next.name, text: statusText, tone: next.stock === 0 ? "red" : "green", read: false, shopId: shop.id });
          state.events = state.events.slice(0, 100);
          addActivity(`${next.name} ${statusText}`, `${shop.name} · 刚刚`, next.stock === 0 ? "red" : "", shop.id);
          if (!notificationCapabilities.backgroundMonitorSupported && (next.stock === 0 || state.notifyRecovery)) sendNotification(`${shop.name}：${next.name}，${statusText}`, next, shop).catch(() => {});
        }
        return next;
      }).sort((a, b) => a.sortIndex - b.sortIndex).map(({ sortIndex, ...product }) => product);
    }
    shop.lastChecked = Date.now(); addActivity("完成一次库存同步", `${shop.name} · 刚刚`, "", shop.id); saveState(); renderAll(); if (!silent) toast("库存已更新");
  } catch (error) {
    if (error.name === "AbortError" || !state.shops.some(item => item.id === shop.id)) return;
    shop.lastChecked = Date.now(); saveState(); renderAll(); if (!silent) toast(`同步失败：${error.message || "已保留本地数据"}`);
  } finally {
    if (shopRefreshControllers.get(shop.id) === controller) shopRefreshControllers.delete(shop.id);
    if (!silent) setRefreshBusy(false);
  }
}
function scheduleRefresh() { window.clearInterval(refreshTimer); if (notificationCapabilities.backgroundMonitorSupported) return; refreshTimer = window.setInterval(() => state.shops.filter(shop => shop.enabled).forEach(shop => refreshShop(shop, true)), Number(state.interval) * 60 * 1000); }

function switchView(view) { document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view)); document.querySelectorAll(".view").forEach(item => item.classList.toggle("active", item.id === `view-${view}`)); const titles = { overview: "监控总览", shops: "店铺与商品", monitors: "重点监控", notifications: "通知渠道", settings: "系统设置" }; document.getElementById("pageTitle").textContent = titles[view] || "监控总览"; }
function openModal(id) { const modal = document.getElementById(id); modal.classList.add("visible"); modal.setAttribute("aria-hidden", "false"); window.requestAnimationFrame(() => modal.querySelector("form input, form textarea, form select, form button")?.focus()); }
function closeModal(id) { const modal = document.getElementById(id); modal.classList.remove("visible"); modal.setAttribute("aria-hidden", "true"); }
function setRefreshBusy(busy) {
  const button = document.getElementById("refreshButton");
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
  button.setAttribute("aria-busy", String(busy));
  button.title = busy ? "正在同步库存" : "立即刷新";
}

document.addEventListener("click", event => {
  const productName = event.target.closest(".product-name, .rule-item h4");
  if (productName) {
    const control = productName.closest("tr, .rule-item")?.querySelector("[data-monitor]");
    const result = control ? findProduct(control.dataset.monitor) : null;
    if (result?.shop?.url) {
      window.open(result.shop.url, "_blank", "noopener,noreferrer");
      return;
    }
  }
  if (event.target.classList.contains("modal-backdrop")) { closeModal(event.target.id); return; }
  const nav = event.target.closest("[data-view]"); if (nav) { switchView(nav.dataset.view); return; }
  const jump = event.target.closest("[data-view-jump]"); if (jump) { switchView(jump.dataset.viewJump); return; }
  const close = event.target.closest("[data-close-modal]"); if (close) { closeModal(close.dataset.closeModal); return; }
  const moveShop = event.target.closest("[data-move-shop]"); if (moveShop) { if (moveItem(state.shops, moveShop.dataset.moveShop, moveShop.dataset.direction)) { saveState(); renderAll(); } return; }
  const moveProduct = event.target.closest("[data-move-product]"); if (moveProduct) { const shop = currentShop(); if (shop && moveItem(shop.products, moveProduct.dataset.moveProduct, moveProduct.dataset.direction)) { saveState(); renderAll(); } return; }
  const deleteShop = event.target.closest("[data-delete-shop]");
  if (deleteShop) {
    const shop = state.shops.find(item => item.id === deleteShop.dataset.deleteShop);
    if (!shop || !window.confirm(`确认删除店铺“${shop.name}”吗？`)) return;
    shopRefreshControllers.get(shop.id)?.abort();
    shopRefreshControllers.delete(shop.id);
    state.shops = state.shops.filter(item => item.id !== shop.id);
    state.activity = state.activity.filter(item => item.shopId ? item.shopId !== shop.id : !String(item.meta || "").startsWith(`${shop.name} ·`));
    state.events = state.events.filter(item => item.shopId !== shop.id);
    state.notificationLog = state.notificationLog.filter(item => item.shopId !== shop.id);
    if (!state.shops.length) { state.activity = []; state.events = []; state.notificationLog = []; }
    if (state.selectedShopId === shop.id) state.selectedShopId = state.shops[0]?.id || null;
    selectedCategory = "all";
    saveState(); renderAll(); toast("店铺及关联记录已删除");
    return;
  }
  const shopSelect = event.target.closest("[data-select-shop]"); if (shopSelect) { state.selectedShopId = shopSelect.dataset.selectShop; selectedCategory = "all"; saveState(); renderAll(); return; }
  const category = event.target.closest("[data-category]"); if (category) { selectedCategory = category.dataset.category; renderProducts(); return; }
  const favShop = event.target.closest("[data-favorite-shop]"); if (favShop) { const shop = state.shops.find(item => item.id === favShop.dataset.favoriteShop); if (shop) shop.favorite = !shop.favorite; saveState(); renderAll(); return; }
  const favProduct = event.target.closest("[data-favorite-product]"); if (favProduct) { const result = findProduct(favProduct.dataset.favoriteProduct); if (result) result.product.favorite = !result.product.favorite; saveState(); renderAll(); return; }
  const channelConfig = event.target.closest("[data-channel-config]"); if (channelConfig) { openChannelConfig(channelConfig.dataset.channelConfig); return; }
  const channelRefresh = event.target.closest("[data-channel-refresh]"); if (channelRefresh) { refreshChannelStatus(true); return; }
  const focus = event.target.closest("[data-focus-product]"); if (focus) { const result = findProduct(focus.dataset.focusProduct); if (result) { state.selectedShopId = result.shop.id; selectedCategory = result.product.category; switchView("shops"); renderAll(); } return; }
});

document.addEventListener("change", event => {
  if (event.target.matches("[data-monitor]")) { toggleMonitor(event.target.dataset.monitor, event.target.checked); return; }
  if (event.target.id === "pollInterval") { state.interval = Number(event.target.value); saveState(); renderSettings(); scheduleRefresh(); toast(`已调整为每 ${state.interval} 分钟轮询`); return; }
  if (event.target.id === "categoryFilter") { selectedCategory = event.target.value; renderProducts(); return; }
  if (event.target.id === "stockFilter" || event.target.id === "productSearch") { renderProducts(); return; }
});
document.getElementById("productSearch").addEventListener("input", renderProducts);
document.getElementById("refreshButton").addEventListener("click", () => refreshShop());
document.getElementById("addShopButton").addEventListener("click", () => openModal("shopModal"));
document.getElementById("addShopButtonInline").addEventListener("click", () => openModal("shopModal"));
document.getElementById("testNotificationButton").addEventListener("click", testNotifications);
document.getElementById("channelConfigForm").addEventListener("submit", saveChannelConfig);
document.getElementById("cloudLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.getElementById("cloudLoginToken");
  const button = document.getElementById("cloudLoginButton");
  sessionAdminToken = input.value.trim();
  if (!sessionAdminToken) return toast("请输入服务端管理口令");
  button.disabled = true;
  const loaded = await loadCloudState({ silent: true });
  if (loaded) {
    adminNoticeShown = false;
    closeModal("cloudLoginModal");
    input.value = "";
    await refreshChannelStatus();
    renderAll();
    scheduleRefresh();
    if (legacyMigrationPending) toast("已读取旧数据，保存设置后完成服务端迁移");
  } else {
    openModal("cloudLoginModal");
    toast("管理口令无效或服务端未就绪");
  }
  button.disabled = false;
});
document.getElementById("markAllRead").addEventListener("click", () => { state.events = state.events.map(event => ({ ...event, read: true })); saveState(); renderEvents(); toast("事件已标记为已读"); });
document.getElementById("addRuleButton").addEventListener("click", () => { switchView("shops"); toast("请在商品清单中开启重点监控"); });
document.getElementById("saveSettingsButton").addEventListener("click", async () => { const adminInput = document.getElementById("workerAdminToken"); if (adminInput?.value.trim()) sessionAdminToken = adminInput.value.trim(); state.interval = Number(document.getElementById("settingsInterval").value); state.keepLastStock = document.getElementById("keepLastStock").checked; state.notifyRecovery = document.getElementById("notifyRecovery").checked; state.notifyOnlyMonitored = document.getElementById("notifyOnlyMonitored").checked; renderAll(); scheduleRefresh(); window.clearTimeout(cloudSaveTimer); await persistCloudState(true); });
document.getElementById("exportConfig").addEventListener("click", () => { const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "stock-watch-config.json"; anchor.click(); URL.revokeObjectURL(url); toast("配置已导出"); });
document.getElementById("shopForm").addEventListener("submit", async event => { event.preventDefault(); const name = document.getElementById("shopName").value.trim(); const url = document.getElementById("shopUrl").value.trim(); const note = document.getElementById("shopNote").value.trim(); let parsedUrl; try { parsedUrl = new URL(url); } catch { return toast("请输入有效的店铺链接"); } if (!["http:", "https:"].includes(parsedUrl.protocol)) return toast("店铺链接必须使用 http 或 https"); const tokenMatch = parsedUrl.pathname.match(/\/shop\/([^/?#]+)/i); if (!tokenMatch) return toast("店铺链接需包含 /shop/店铺标识"); const shop = { id: `shop-${Date.now()}`, name: name || `店铺 ${tokenMatch[1]}`, customName: Boolean(name), url: parsedUrl.href, token: tokenMatch[1], note, enabled: true, favorite: false, lastChecked: Date.now(), categories: [], products: [] }; state.shops.push(shop); state.selectedShopId = shop.id; saveState(); closeModal("shopModal"); event.target.reset(); renderAll(); switchView("shops"); await refreshShop(shop); });

document.getElementById("shopForm").addEventListener("submit", event => {
  const value = document.getElementById("shopUrl").value.trim();
  try {
    if (new URL(value).protocol !== "https:") {
      event.preventDefault();
      event.stopImmediatePropagation();
      toast("店铺链接必须使用 HTTPS");
    }
  } catch {}
}, true);
window.addEventListener("keydown", event => { if (event.key === "Escape") document.querySelectorAll(".modal-backdrop.visible").forEach(modal => closeModal(modal.id)); });
async function initializeApp() {
  await loadCloudState();
  await refreshChannelStatus();
  renderAll();
  scheduleRefresh();
}
initializeApp();
window.setInterval(() => { if (!document.hidden) renderStats(); }, 30000);
