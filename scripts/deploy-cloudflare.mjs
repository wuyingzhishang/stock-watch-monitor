import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = resolve(root, "wrangler.toml");
const workerName = "stock-watch-monitor";
const databaseName = process.env.CLOUDFLARE_D1_NAME || workerName;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function parseJsonOutput(output) {
  const text = String(output || "");
  for (const start of [text.indexOf("{"), text.indexOf("[")].filter(index => index >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  throw new Error("Wrangler 未返回有效 JSON");
}

function run(args, { input, json = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npx, ["wrangler", ...args], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(`wrangler ${args.join(" ")} 执行失败（${code}）`));
      resolvePromise(json ? parseJsonOutput(stdout) : stdout);
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function databaseIdFrom(value) {
  return value?.database_id || value?.databaseId || value?.id || value?.result?.database_id || value?.result?.id || "";
}

async function findOrCreateDatabase() {
  const listed = await run(["d1", "list", "--json"], { json: true });
  const databases = Array.isArray(listed) ? listed : (listed.result || listed.databases || []);
  const existing = databases.find(item => item.name === databaseName);
  if (existing && databaseIdFrom(existing)) {
    console.log(`复用 D1 数据库：${databaseName}`);
    return databaseIdFrom(existing);
  }
  console.log(`创建 D1 数据库：${databaseName}`);
  const created = await run(["d1", "create", databaseName, "--json"], { json: true });
  const id = databaseIdFrom(created);
  if (!id) throw new Error("D1 创建成功但未找到 database_id");
  return id;
}

async function configureBinding(databaseId) {
  let source = await readFile(configPath, "utf8");
  source = source
    .replace(/^\s*#\s*\[\[d1_databases\]\]\r?\n/m, "")
    .replace(/^\s*#\s*(?:binding|database_name|database_id)\s*=.*\r?\n/gm, "");
  const block = `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${databaseName}"\ndatabase_id = "${databaseId}"\n`;
  if (/^\[\[d1_databases\]\]/m.test(source)) {
    source = source.replace(/(\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*")[^"]*("[\s\S]*?)(?=\n\[|$)/m, `$1${databaseId}$2`);
  } else {
    source = `${source.trimEnd()}\n${block}`;
  }
  await writeFile(configPath, source, "utf8");
}

async function configureAdminSecret() {
  const token = process.env.ADMIN_TOKEN || randomBytes(24).toString("base64url");
  await run(["secret", "put", "ADMIN_TOKEN", "--config", "wrangler.toml"], { input: `${token}\n` });
  if (!process.env.ADMIN_TOKEN) {
    console.log(`\n首次管理口令（仅显示一次）：${token}`);
    console.log("请立即保存此口令，用于打开监控面板和修改云端数据。\n");
  }
}

async function main() {
  try {
    await run(["whoami"]);
  } catch {
    console.log("未检测到 Cloudflare 登录状态，正在打开浏览器登录……");
    await run(["login"]);
  }
  const databaseId = await findOrCreateDatabase();
  await configureBinding(databaseId);
  await run(["d1", "migrations", "apply", databaseName, "--remote", "--config", "wrangler.toml"]);
  await run(["deploy", "--config", "wrangler.toml"]);
  await configureAdminSecret();
  console.log(`\nCloudflare 部署完成：${workerName}`);
}

main().catch(error => {
  console.error(`\n自动部署失败：${error.message}`);
  process.exitCode = 1;
});
