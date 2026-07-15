function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export async function onRequestOptions() { return response({}, 204); }

export async function onRequestPost() {
  return response({ error: "Cloudflare Pages 请在项目 Secrets 中配置通知密钥" }, 501);
}
