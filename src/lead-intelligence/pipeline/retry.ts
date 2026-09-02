import type { RetryPolicy } from './types.js';

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  initialDelayMs: 500,
  maximumDelayMs: 5_000,
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 5) {
    throw new Error('retry attempts must be an integer from 1-5');
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < policy.attempts) {
        await wait(Math.min(policy.maximumDelayMs, policy.initialDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('pipeline concurrency must be an integer from 1-20');
  }
  const results = Array<PromiseSettledResult<R> | undefined>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { status: 'fulfilled', value: await operation(item) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results.filter((result): result is PromiseSettledResult<R> => result !== undefined);
}
