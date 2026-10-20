import { IndexedDbCache } from "./IndexedDbCache.js";

describe("IndexedDbCache Tests", () => {
  test("test", async () => {
    const cache = new IndexedDbCache();
    await cache.init();
    await cache.setItem("key", "value");
    const value = await cache.getItem("key");
    expect(value).toBe("value");

    await cache.removeItem("key");
    const value2 = await cache.getItem("key");
    expect(value2).toBeNull();
  });

  test("a failed request or transaction rejects with an Error, not an Event", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheFailures");
    await cache.init();
    await cache.setItems([["key", "value"]]);

    // abort the transaction the cache opens for each call, failing its pending requests
    const spies = (["put", "delete", "get", "getAllKeys"] as const).map(
      (name) => {
        const method: Function = Reflect.get(IDBObjectStore.prototype, name);
        return vi
          .spyOn(IDBObjectStore.prototype, name)
          .mockImplementation(function (
            this: IDBObjectStore,
            ...args: unknown[]
          ) {
            const request: IDBRequest = Reflect.apply(method, this, args);
            this.transaction.abort();
            return request;
          } as never);
      },
    );
    try {
      const calls: [string, Promise<unknown>][] = [
        ["getItem", cache.getItem("key")],
        ["setItem", cache.setItem("key", "other")],
        ["removeItem", cache.removeItem("key")],
        ["keys", cache.keys()],
        ["getItems", cache.getItems(["key"])],
        ["setItems", cache.setItems([["key", "other"]])],
      ];
      for (const [name, call] of calls) {
        const error = await call.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error, name).toBeInstanceOf(Error);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(await cache.getItem("key")).toBe("value");
    await cache.close();
  });

  test("a batch whose transaction aborts after its requests succeeded rejects", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheLateAbort");
    await cache.init();

    // as a commit that fails (a full quota) does: no request fails, the transaction aborts
    const spies = (["put", "get"] as const).map((name) => {
      const method: Function = Reflect.get(IDBObjectStore.prototype, name);
      return vi
        .spyOn(IDBObjectStore.prototype, name)
        .mockImplementation(function (
          this: IDBObjectStore,
          ...args: unknown[]
        ) {
          const request: IDBRequest = Reflect.apply(method, this, args);
          request.addEventListener("success", () => this.transaction.abort());
          return request;
        } as never);
    });
    try {
      await expect(cache.getItems(["key"])).rejects.toBeInstanceOf(Error);
      await expect(cache.setItems([["key", "value"]])).rejects.toBeInstanceOf(
        Error,
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(await cache.getItem("key")).toBeNull();
    await cache.close();
  });
});
