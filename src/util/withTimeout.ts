// The promise's result, or a rejection with timeoutError() once `milliseconds` pass first; the
// promise itself runs on, it is not cancelled
export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  timeoutError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
