/** Ends a subscription. */
export type Unsubscribe = () => Promise<void>;

/**
 * What ElectrumNetworkProvider needs from a connection to an Electrum server: ElectrumTransport over
 * the network, and mem-cash's in-memory indexer in the tests.
 */
export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  /**
   * Resolves with the result; rejects with an Error for a server error, a lost connection or a timeout.
   * A server error carries the JSON-RPC error's numeric `code` and string `message`, on its `cause`
   * (as electrum-cash gives it) or on the Error itself (as mem-cash does); the provider tells
   * refusals apart by it, so a connection error must not carry that shape (a DOMException does not
   * count).
   * `params` is a positional list, typed `any` because mem-cash types it per method as a tuple.
   */
  request(method: string, params?: any): Promise<unknown>;
  /**
   * Subscribes to a `*.subscribe` method. `onData` receives the notification params, the subscription's
   * own params followed by the status (`[address, status]`, `[header]`), first for the current status
   * and then for every change.
   */
  subscribe(
    method: string,
    params: any,
    onData: (data: any) => void,
  ): Promise<Unsubscribe>;
}
