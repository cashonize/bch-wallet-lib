import ElectrumNetworkProvider from "../src/network/ElectrumNetworkProvider.js";

export interface RequestCounts {
  /** Requests per electrum method. */
  byMethod: Record<string, number>;
  /** The most requests in flight at once. */
  maxInFlight: number;
}

// Wraps the provider's performRequest until restore() is called. Each request is held back one
// macrotask, so that requests started together overlap even on the in-memory chain, which
// answers within the same tick.
export function countRequests(provider: ElectrumNetworkProvider) {
  // performRequest is protected; the tests wrap it from outside
  const target = provider as unknown as {
    performRequest<T>(method: string, parameters?: unknown[]): Promise<T>;
  };
  const original = target.performRequest.bind(provider);
  const counts: RequestCounts = { byMethod: {}, maxInFlight: 0 };
  let inFlight = 0;

  target.performRequest = async <T>(
    method: string,
    parameters?: unknown[],
  ): Promise<T> => {
    counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
    inFlight++;
    counts.maxInFlight = Math.max(counts.maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await original<T>(method, parameters);
    } finally {
      inFlight--;
    }
  };

  return {
    counts,
    // the class method again
    restore: () => {
      delete (target as { performRequest?: unknown }).performRequest;
    },
  };
}
