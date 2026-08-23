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