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

  // the provider calls init() before every request
  test("opens the database once however often init is called, and again after close", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheOpens");
    const open = vi.spyOn(indexedDB, "open");
    try {
      await Promise.all([cache.init(), cache.init()]);
      await cache.init();
      expect(open).toHaveBeenCalledTimes(1);

      await cache.close();
      await cache.init();
      expect(open).toHaveBeenCalledTimes(2);
      await cache.setItem("key", "value");
      expect(await cache.getItem("key")).toBe("value");
    } finally {
      open.mockRestore();
    }
  });

  // a delete or upgrade elsewhere waits for every open connection to close
  async function deleteDatabase(name: string): Promise<"deleted" | "blocked"> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve("deleted");
      request.onblocked = () => resolve("blocked");
      request.onerror = () =>
        reject(request.error ?? new Error("deleteDatabase failed"));
    });
  }

  test("a close while the database opens leaves no connection open", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheCloseWhileOpening");
    const opening = cache.init();
    await cache.close();
    await opening;
    expect(await deleteDatabase("IndexedDbCacheCloseWhileOpening")).toBe(
      "deleted",
    );
  });

  test("gives up its connection for a delete elsewhere, and opens again on the next call", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheVersionChange");
    const open = vi.spyOn(indexedDB, "open");
    try {
      await cache.init();
      expect(await deleteDatabase("IndexedDbCacheVersionChange")).toBe(
        "deleted",
      );
      await cache.init();
      expect(open).toHaveBeenCalledTimes(2);
      await cache.setItem("key", "value");
      expect(await cache.getItem("key")).toBe("value");
    } finally {
      open.mockRestore();
      await cache.close();
    }
  });

  test("opens again after the browser drops the connection", async () => {
    const cache = new IndexedDbCache("IndexedDbCacheDropped");
    await cache.init();
    const database = cache["db"]!;
    database.close();
    database.onclose?.(new Event("close"));
    await cache.init();
    await cache.setItem("key", "value");
    expect(await cache.getItem("key")).toBe("value");
    await cache.close();
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
