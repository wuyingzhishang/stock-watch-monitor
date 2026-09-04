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
