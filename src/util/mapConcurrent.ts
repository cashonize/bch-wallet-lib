/** Requests the library keeps in flight at most when it fans out over a list itself. */
export const DEFAULT_CONCURRENCY = 10;

/**
 * A bound that several fan-outs share: at most `concurrency` of the calls run through it are
 * running at once, whichever fan-out they belong to (`Infinity`: no limit).
 */
export class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly concurrency: number) {
    // Infinity is no limit: every call starts at once
    if (
      concurrency !== Infinity &&
      (!Number.isInteger(concurrency) || concurrency < 1)
    ) {
      throw new RangeError(
        `concurrency must be a positive integer or Infinity, got ${concurrency}`,
      );
    }
  }

  async run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.running < this.concurrency) {
      this.running++;
    } else {
      // the slot is handed over by the call that finishes, so no new call can take it in between
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.running--;
      }
    }
  }
}

/**
 * `Promise.all(items.map(fn))` with at most `concurrency` calls of `fn` running at once
 * (`Infinity`: no limit), or within a `Limiter` shared with other fan-outs. The results keep the
 * order of `items`; the first rejection rejects the whole, as with `Promise.all`, and no further
 * call is started after it.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number | Limiter,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let limiter: Limiter;
  if (concurrency instanceof Limiter) {
    limiter = concurrency;
  } else {
    limiter = new Limiter(concurrency);
  }

  let failed = false;
  const results = await Promise.all(
    items.map((item, index) =>
      limiter.run(async () => {
        // its result is not used: the whole has rejected already
        if (failed) return undefined as R;
        try {
          return await fn(item, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }),
    ),
  );
  return results;
}
