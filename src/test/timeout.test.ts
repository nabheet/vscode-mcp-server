import { describe, it, expect } from 'vitest';
import { withTimeout } from '../utils/timeout';

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