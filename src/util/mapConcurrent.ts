/** Requests the library keeps in flight at most when it fans out over a list itself. */
export const DEFAULT_CONCURRENCY = 10;

/**
 * `Promise.all(items.map(fn))` with at most `concurrency` calls of `fn` running at once. The
 * results keep the order of `items`; the first rejection rejects the whole, as with `Promise.all`,
 * and no further call is started after it.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `concurrency must be a positive integer, got ${concurrency}`,
    );
  }

  const results: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
