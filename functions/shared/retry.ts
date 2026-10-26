export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff delay for the given 1-based attempt. */
export function backoffDelay(attempt: number, baseDelayMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * baseDelayMs * 2 ** (attempt - 1));
}

export async function sleepBackoff(attempt: number, opts: RetryOptions = {}): Promise<void> {
  await (opts.sleep ?? defaultSleep)(backoffDelay(attempt, opts.baseDelayMs ?? 100, opts.random));
}
