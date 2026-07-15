function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" }
  });
}

export async function onRequestOptions() { return response({}, 204); }

export async function onRequestGet(context) {
  return response({
    channels: {
      feishu: Boolean(context.env.FEISHU_WEBHOOK),
      qq: Boolean(context.env.QQ_WEBHOOK),
      telegram: Boolean(context.env.TELEGRAM_BOT_TOKEN && context.env.TELEGRAM_CHAT_ID),
      dingtalk: Boolean(context.env.DINGTALK_WEBHOOK),
      wecom: Boolean(context.env.WECOM_WEBHOOK)
    },
    webConfigSupported: false,
    setupRequired: false,
    deploymentMode: "cloudflare"
  });
}

async function deliver(channel, url, body) {
  try {
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { channel, ok: result.ok, status: result.status };
  } catch (error) {
    return { channel, ok: false, error: error instanceof Error ? error.message : "投递失败" };
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const text = body.text || `库存事件：${body.product || "商品"}，当前库存 ${body.stock ?? 0}`;
    const tasks = [];

    if (context.env.FEISHU_WEBHOOK) {
      tasks.push(deliver("feishu", context.env.FEISHU_WEBHOOK, { msg_type: "text", content: { text } }));
    }
    if (context.env.QQ_WEBHOOK) {
      tasks.push(deliver("qq", context.env.QQ_WEBHOOK, { msg_type: "text", content: text, message: text }));
    }
    if (context.env.TELEGRAM_BOT_TOKEN && context.env.TELEGRAM_CHAT_ID) {
      tasks.push(deliver("telegram", `https://api.telegram.org/bot${context.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: context.env.TELEGRAM_CHAT_ID, text }));
    }
    if (context.env.DINGTALK_WEBHOOK) tasks.push(deliver("dingtalk", context.env.DINGTALK_WEBHOOK, { msgtype: "text", text: { content: text } }));
    if (context.env.WECOM_WEBHOOK) tasks.push(deliver("wecom", context.env.WECOM_WEBHOOK, { msgtype: "text", text: { content: text } }));

    const results = await Promise.all(tasks);
    return response({ sent: results.some(result => result.ok), configured: results.length, results });
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : "通知发送失败" }, 400);
  }
}
