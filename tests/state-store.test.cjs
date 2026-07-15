const assert = require("node:assert/strict");
const test = require("node:test");
const { loadStoredState, migrateState } = require("../state-store.js");

const channelDefinitions = [
  { id: "feishu", name: "飞书机器人", type: "feishu", env: "FEISHU_WEBHOOK" }
];

const defaultState = {
  schemaVersion: 3,
  shops: [{ id: "shop-demo001", name: "示例店铺", customName: true, products: [] }],
  selectedShopId: "shop-demo001",
  channels: [{ ...channelDefinitions[0], connected: false }],
  activity: [{ title: "示例动态" }],
  events: [],
  notificationLog: []
};

function createStorage(initialState) {
  let value = initialState === undefined ? null : JSON.stringify(initialState);
  return {
    getItem: () => value,
    setItem: (_key, nextValue) => { value = nextValue; }
  };
}

test("旧状态只迁移一次并写入当前版本号", () => {
  const migrated = migrateState({
    schemaVersion: 2,
    shops: [{ id: "old-shop", name: "旧店铺", products: [] }],
    selectedShopId: "old-shop",
    channels: []
  }, defaultState, channelDefinitions);

  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.shops.map(shop => shop.id), ["shop-demo001"]);
  assert.equal(migrated.selectedShopId, "shop-demo001");
});

test("删除示例店铺后自定义店铺在连续两次重新加载后仍保留", () => {
  const storage = createStorage({ schemaVersion: 2, channels: [] });
  const initialMigration = loadStoredState(storage, "stock-watch-monitor", defaultState, channelDefinitions);
  const customShop = {
    id: "shop-custom001",
    name: "我的店铺",
    customName: true,
    url: "https://shop.example.com/shop/CUSTOM001",
    products: [{ id: "product-1", name: "自定义商品", stock: 2 }]
  };

  initialMigration.shops = [customShop];
  initialMigration.selectedShopId = customShop.id;
  storage.setItem("stock-watch-monitor", JSON.stringify(initialMigration));

  const firstReload = loadStoredState(storage, "stock-watch-monitor", defaultState, channelDefinitions);
  const secondReload = loadStoredState(storage, "stock-watch-monitor", defaultState, channelDefinitions);

  assert.equal(firstReload.schemaVersion, 3);
  assert.equal(secondReload.schemaVersion, 3);
  assert.deepEqual(secondReload.shops, [customShop]);
  assert.equal(secondReload.selectedShopId, customShop.id);
  assert.equal(secondReload.shops.some(shop => shop.id === "shop-demo001"), false);
});

test("后续版本升级不会恢复示例店铺", () => {
  const customShop = { id: "shop-custom001", name: "我的店铺", products: [] };
  const nextDefaults = { ...defaultState, schemaVersion: 4 };
  const upgraded = migrateState({
    ...defaultState,
    schemaVersion: 3,
    shops: [customShop],
    selectedShopId: customShop.id
  }, nextDefaults, channelDefinitions);

  assert.equal(upgraded.schemaVersion, 4);
  assert.deepEqual(upgraded.shops, [{ ...customShop, customName: true }]);
  assert.equal(upgraded.selectedShopId, customShop.id);
});

test("损坏的本地状态会恢复为可用默认值", () => {
  const storage = createStorage({ ...defaultState, shops: { invalid: true } });
  const recovered = loadStoredState(storage, "stock-watch-monitor", defaultState, channelDefinitions);

  assert.deepEqual(recovered.shops, defaultState.shops);
  assert.equal(recovered.schemaVersion, defaultState.schemaVersion);
});
