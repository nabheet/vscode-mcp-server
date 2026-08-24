import { describe, it, expect } from 'vitest';
import { withTimeout, withLaunchBudget } from '../utils/timeout';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'too slow');
    expect(result).toBe('ok');
  });

  it('rejects with the original error when the promise fails in time', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, 'too slow'),
    ).rejects.toThrow('boom');
  });

  it('rejects with the timeout message when the promise never settles', async () => {
    await expect(
      withTimeout(new Promise(() => {}), 50, 'hung forever'),
    ).rejects.toThrow('hung forever');
  });

  it('rejects faster than the underlying promise would settle', async () => {
    const start = Date.now();
    let settledLate = false;
    const slow = new Promise<void>((resolve) => {
      setTimeout(() => {
        settledLate = true;
        resolve();
      }, 500);
    });
    await expect(withTimeout(slow, 50, 'timeout')).rejects.toThrow('timeout');
    expect(Date.now() - start).toBeLessThan(500);
    expect(settledLate).toBe(false);
  });
});

describe('withLaunchBudget', () => {
  it('resolves when the phase completes within the budget', async () => {
    await expect(withLaunchBudget(async () => {}, 1000, 'budget expired')).resolves.toBeUndefined();
  });

  it('rejects at the budget and flips isAborted so the phase can stop issuing side effects', async () => {
    let isAbortedDuring: boolean | undefined;
    let runDone: () => void = () => {};
    const runDoneP = new Promise<void>((r) => { runDone = r; });
    const run = async (isAborted: () => boolean) => {
      // Simulate work that outlives the budget (e.g. an in-flight startDebugging)
      await new Promise((r) => setTimeout(r, 30));
      isAbortedDuring = isAborted();
      runDone();
    };

    await expect(withLaunchBudget(run, 5, 'budget expired')).rejects.toThrow('budget expired');
    await runDoneP; // wait for the abandoned phase to finish
    expect(isAbortedDuring).toBe(true);
  });

  it('keeps isAborted false when the phase completes in time', async () => {
    let probe: boolean | undefined;
    await withLaunchBudget(async (isAborted) => {
      probe = isAborted();
    }, 1000, 'budget expired');
    expect(probe).toBe(false);
  });
});