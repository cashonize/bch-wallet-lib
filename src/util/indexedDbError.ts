// A failed request's or transaction's error is a DOMException; it is null only while it has not
// failed (or, for a transaction, when it was aborted by a call to abort())
export function indexedDbError(target: IDBRequest | IDBTransaction): Error {
  return target.error ?? new Error("The IndexedDB request failed");
}
