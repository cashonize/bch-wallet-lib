import type { CancelFn } from "../wallet/interface.js";
import { toError } from "./toError.js";

/**
 * Run a watch callback, sync or async, and hand its throw or rejection to console.error. Never
 * throws and never leaves a promise unhandled.
 */
export function runCallback(callback: () => unknown): void {
  const report = (error: unknown) => console.error(error);
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
      cancel().then(settle, (error) => reject(toError(error)));
    };
    watch((value) => finish(() => resolve(value)), {
      onError: (error) => finish(() => reject(toError(error))),
    }).then(
      (made) => {
        if (settled) {
          made().catch((error) => console.error(error));
        } else {
          cancel = made;
        }
      },
      (error) => finish(() => reject(toError(error))),
    );
  });
}
