function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-proxy-url"
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
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const data = await response.json();
  if (data.code !== 1) throw new Error(data.msg || "upstream error");
  return data.data;
}

export async function onRequestOptions() {
  return json({}, 204);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const token = url.searchParams.get("token") || url.searchParams.get("shop");
  if (!token || !/^[A-Za-z0-9]+$/.test(token)) return json({ error: "缺少有效的店铺 token" }, 400);
  let source;
  try { source = stockSource(url.searchParams.get("url"), token, context.env); }
  catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  if (source.demo) return json(demoStockData(token));
  const upstream = source.upstream;

  try {
    const [shop, categories] = await Promise.all([
      post(upstream, "/shopApi/Shop/info", { token }),
      post(upstream, "/shopApi/Shop/categoryList", { token, goods_type: "card" })
    ]);
    const pages = [];
    const pageSize = 50;
    for (let current = 1; current <= 20; current += 1) {
      const page = await post(upstream, "/shopApi/Shop/goodsList", { token, goods_type: "card", current, pageSize, category_id: 0, keywords: "" });
      pages.push(page);
      if (!Array.isArray(page?.list) || page.list.length < pageSize) break;
    }

    const products = pages.flatMap(result => result?.list || []).map(item => ({
      id: item.goods_key,
      name: item.name,
      category: item.category?.name || "未分类",
      price: Number(item.price || 0),
      stock: Number(item.extend?.stock_count || 0),
      monitored: false,
      favorite: false
    }));

    return json({
      fetchedAt: Date.now(),
      shop: { name: shop.nickname, token: shop.token, link: shop.link, description: shop.description },
      categories: (categories || []).map(item => item.name),
      products
    });
  } catch (error) {
    return json({ error: "店铺接口暂时不可用", detail: error instanceof Error ? error.message : String(error) }, 502);
  }
}
