import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../app.js", import.meta.url), "utf8");
const htmlSource = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("前端不将业务状态写入浏览器持久存储", () => {
  assert.doesNotMatch(appSource, /localStorage\.setItem\(["']stock-watch-monitor["']/);
  assert.doesNotMatch(htmlSource, /state-store\.js/);
});

test("前端仅读取旧 localStorage 数据用于一次性服务端迁移", () => {
  assert.match(appSource, /localStorage\.getItem\("stock-watch-monitor"\)/);
  assert.match(appSource, /localStorage\.removeItem\("stock-watch-monitor"\)/);
  assert.match(appSource, /fetch\("\.\/api\/app-state"/);
});

test("前端在提交前拒绝 HTTP 店铺链接", () => {
  assert.match(appSource, /店铺链接必须使用 HTTPS/);
  assert.match(appSource, /new URL\(value\)\.protocol !== "https:"/);
});

test("商品名称点击后打开对应店铺链接", () => {
  assert.match(appSource, /closest\("\.product-name, \.rule-item h4"\)/);
  assert.match(appSource, /window\.open\(result\.shop\.url, "_blank", "noopener,noreferrer"\)/);
});
