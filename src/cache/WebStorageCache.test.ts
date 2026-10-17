import { WebStorageCache } from "./WebStorageCache.js";

describe("WebStorageCache Tests", () => {
  test("test", async () => {
    const cache = new WebStorageCache();
    await cache.init();
    await cache.setItem("key", "value");
    const value = await cache.getItem("key");
    expect(value).toBe("value");

    await cache.removeItem("key");
    const value2 = await cache.getItem("key");
    expect(value2).toBeNull();
  });

  test("clear removes only the cache's own keys", async () => {
    const cache = new WebStorageCache();
    await cache.init();
    localStorage.setItem("app-setting", "keep");
    localStorage.setItem("txraw-regtest-app", "keep too");
    await cache.setItem("txraw-regtest-aa", "00");
    await cache.setItems([
      ["txraw-regtest-bb", "01"],
      ["header-regtest-1-true", "{}"],
    ]);
    expect(localStorage.getItem("txraw-regtest-aa")).toBeNull();

    await cache.clear();

    expect(localStorage.getItem("app-setting")).toBe("keep");
    expect(localStorage.getItem("txraw-regtest-app")).toBe("keep too");
    const left = await cache.getItems([
      "txraw-regtest-aa",
      "txraw-regtest-bb",
      "header-regtest-1-true",
    ]);
    expect([...left.values()]).toEqual([null, null, null]);
    localStorage.removeItem("app-setting");
    localStorage.removeItem("txraw-regtest-app");
  });
});
