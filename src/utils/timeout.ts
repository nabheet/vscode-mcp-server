/**
 * Run a promise with a hard deadline. If it does not settle within `ms`,
 * reject with an Error containing `message`. The underlying promise keeps
 * running in the background but its result is discarded.
 *
 * This is the guard against hung VS Code / DAP API calls (e.g. a debug
 * adapter that never answers customRequest) silently killing the MCP
 * server: without it, tool handlers can await forever and the HTTP port
 * stops responding.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run a synchronous-ish launch/work phase under a hard budget. Unlike
 * `withTimeout` (which abandons the underlying promise but cannot stop it),
 * this gives the running phase an `isAborted()` probe: once the budget fires
 * the caller is rejected immediately AND `isAborted()` flips true, so the
 * phase can stop issuing NEW side-effecting calls (e.g. further
 * `startDebugging` calls for remaining compound members). VS Code offers no
 * way to cancel an in-flight launch, so we stop the cascade instead.
 *
 * The phase is expected to swallow its own per-call errors; the only
 * rejection this promise produces is the budget expiry (or a thrown error
 * escaping the phase).
 */
export function withLaunchBudget(
  run: (isAborted: () => boolean) => Promise<void>,
  ms: number,
  message: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let aborted = false;
    const timer = setTimeout(() => {
      aborted = true;
      reject(new Error(message));
    }, ms);
    run(() => aborted).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}