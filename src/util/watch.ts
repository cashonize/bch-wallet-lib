import type { CancelFn } from "../wallet/interface.js";

/**
 * Run a watch callback, sync or async, and hand its throw or rejection to onError, or to
 * console.error without one. Never throws and never leaves a promise unhandled.
 */
export function runCallback(
  callback: () => unknown,
  onError?: (error: unknown) => void,
): void {
  const report = (error: unknown) => {
    if (!onError) {
      console.error(error);
      return;
    }
    try {
      // an async onError (only possible from untyped code) gets its rejection reported too
      settle(onError(error), (e) => console.error(e));
    } catch (handlerError) {
      console.error(handlerError);
    }
  };
  try {
    settle(callback(), report);
  } catch (error) {
    report(error);
  }
}

function settle(result: unknown, report: (error: unknown) => void) {
  if (typeof (result as PromiseLike<void> | undefined)?.then === "function") {
    Promise.resolve(result).catch(report);
  }
}

/**
 * Wait on a watch: settles with the first value its callback passes to done, or rejects with
 * the error of making the watch or the first one it reports to onError, and ends the watch.
 */
export function waitOnWatch<T>(
  watch: (
    done: (value: T) => void,
    options: { onError: (error: unknown) => void },
  ) => Promise<CancelFn>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancel: CancelFn | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      // a watch still being made is ended once it is in place
      if (!cancel) {
        settle();
        return;
      }
      cancel().then(settle, reject);
    };
    watch((value) => finish(() => resolve(value)), {
      onError: (error) => finish(() => reject(error)),
    }).then(
      (made) => {
        if (settled) {
          made().catch((error) => console.error(error));
        } else {
          cancel = made;
        }
      },
      (error) => finish(() => reject(error)),
    );
  });
}
