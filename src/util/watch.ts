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
