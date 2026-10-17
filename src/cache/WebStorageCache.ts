import { CacheProvider } from "./interface.js";

// localStorage is shared with the host app, so every key is namespaced and clear() leaves the
// app's own keys alone
const KEY_PREFIX = "bch-wallet-lib:";

// super thin wrapper around localStorage
export class WebStorageCache implements CacheProvider {
  async init() {
    return;
  }

  // Writes are best effort: localStorage holds about 5 MB per origin, and a full one (or one the
  // browser blocks) must not fail the request whose result was being cached
  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(KEY_PREFIX + key, value);
    } catch {
      // not cached
    }
  }

  async getItem(key: string): Promise<string | null> {
    return localStorage.getItem(KEY_PREFIX + key);
  }

  async getItems(keys: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    for (const key of keys) {
      results.set(key, localStorage.getItem(KEY_PREFIX + key));
    }
    return results;
  }

  async setItems(entries: [string, string][]): Promise<void> {
    try {
      for (const [key, value] of entries) {
        localStorage.setItem(KEY_PREFIX + key, value);
      }
    } catch {
      // the rest would not fit either
    }
  }

  async removeItem(key: string): Promise<void> {
    localStorage.removeItem(KEY_PREFIX + key);
  }

  async clear(): Promise<void> {
    // collected first, since removing while indexing shifts the indices
    const ownKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) ownKeys.push(key);
    }
    for (const key of ownKeys) {
      localStorage.removeItem(key);
    }
  }
}
