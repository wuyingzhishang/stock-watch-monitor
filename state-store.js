(function exposeStateStore(root, factory) {
  const stateStore = factory();
  if (typeof module === "object" && module.exports) module.exports = stateStore;
  if (root) root.StockWatchState = stateStore;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStateStore() {
  const legacyDataResetVersion = 3;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function migrateState(savedState, defaultState, channelDefinitions) {
    const hasSavedState = savedState && typeof savedState === "object" && !Array.isArray(savedState);
    const loaded = hasSavedState ? { ...clone(defaultState), ...savedState } : clone(defaultState);

    if (hasSavedState && Number(savedState.schemaVersion || 0) < legacyDataResetVersion) {
      loaded.shops = clone(defaultState.shops);
      loaded.selectedShopId = defaultState.selectedShopId;
      loaded.activity = clone(defaultState.activity);
      loaded.events = [];
      loaded.notificationLog = [];
    }
    loaded.schemaVersion = defaultState.schemaVersion;

    const priorChannels = new Map((loaded.channels || []).map(channel => [channel.id, channel]));
    loaded.channels = channelDefinitions.map(channel => ({
      ...channel,
      connected: Boolean(priorChannels.get(channel.id)?.connected)
    }));
    loaded.shops = (loaded.shops || []).map(shop => ({ ...shop, customName: shop.customName ?? true }));

    if (!loaded.shops.length) {
      loaded.activity = [];
      loaded.events = [];
      loaded.notificationLog = [];
    }

    return loaded;
  }

  function loadStoredState(storage, storageKey, defaultState, channelDefinitions) {
    let savedState = null;
    try {
      const saved = storage.getItem(storageKey);
      savedState = saved ? JSON.parse(saved) : null;
    } catch {}

    let loaded;
    try {
      loaded = migrateState(savedState, defaultState, channelDefinitions);
    } catch {
      loaded = migrateState(null, defaultState, channelDefinitions);
    }
    try { storage.setItem(storageKey, JSON.stringify(loaded)); } catch {}
    return loaded;
  }

  return { loadStoredState, migrateState };
});
