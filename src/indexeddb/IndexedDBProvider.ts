import type StorageProvider from "../db/StorageProvider.js";
import type { WalletDbEntryI } from "../db/interface.js";

// the object store mainnet-js 3.1.7 keeps its rows in, keyed by name
const STORE_NAME = "wallet";

export default class IndexedDBProvider implements StorageProvider {
  private dbName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName: string) {
    this.dbName = dbName;
  }

  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 31);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "name" });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(requestError(request));
    });
  }

  public async init() {
    await this.openDB();
    return this;
  }

  public async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return this;
  }

  public async addWallet(name: string, walletId: string): Promise<boolean> {
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(name);
      getReq.onsuccess = () => {
        if (getReq.result) {
          resolve(false);
        } else {
          const addReq = store.add({ name, wallet: walletId });
          addReq.onsuccess = () => resolve(true);
          addReq.onerror = () => reject(requestError(addReq));
        }
      };
      getReq.onerror = () => reject(requestError(getReq));
    });
  }

  public async getWallet(name: string): Promise<WalletDbEntryI | undefined> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(requestError(req));
    });
  }

  public async getWallets(): Promise<Array<WalletDbEntryI>> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(requestError(req));
    });
  }

  public async updateWallet(name: string, walletId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(name);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          resolve();
        } else {
          const putReq = store.put({ name, wallet: walletId });
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(requestError(putReq));
        }
      };
      getReq.onerror = () => reject(requestError(getReq));
    });
  }

  public async walletExists(name: string): Promise<boolean> {
    return (await this.getWallet(name)) !== undefined;
  }

  public async deleteWallet(name: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(requestError(req));
    });
  }
}

// A failed request's error is a DOMException; it is null only while the request has not failed
function requestError(request: IDBRequest): Error {
  return request.error ?? new Error("The IndexedDB request failed");
}
