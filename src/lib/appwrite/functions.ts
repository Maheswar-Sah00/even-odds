import { ExecutionMethod, Functions } from 'appwrite';
import { ServiceError, type ErrorKind } from '@shared/errors.ts';
import type { BrowserAppwrite } from './client.ts';

/** Envelope returned by every Even Odds Function (functions/shared/function-runtime.ts). */
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; field?: string } };

const KIND: Record<string, ErrorKind> = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  validation: 'validation',
  conflict: 'conflict',
  locked: 'forbidden',
  expired: 'validation',
  rate_limited: 'rate_limited',
  retry: 'server',
  server: 'server',
};

/** A Function refused the request; `code` and `field` come from the server. */
export class FunctionError extends ServiceError {
  readonly code: string;
  readonly field: string | undefined;

  constructor(operation: string, code: string, message: string, status: number, field?: string) {
    super(operation, { kind: KIND[code] ?? 'unknown', status, type: code, message, retryable: code === 'retry' || code === 'rate_limited' });
    this.code = code;
    this.field = field;
  }
}

/**
 * Appwrite Cloud refuses bursts with 429 BEFORE the Function runs (Task 14 load tests saw up to
 * half of a 500-request burst refused), so retrying that refusal can never repeat an action.
 * Up to 3 retries with full-jitter backoff; the app's own per-account limits (a 429 inside the
 * Function's envelope) are not retried: their windows are an hour long.
 */
export async function withPlatformRetry<T>(call: () => Promise<T>, opts: { attempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ServiceError) || err.mapped.kind !== 'rate_limited' || attempt >= attempts) throw err;
      await sleep(Math.random() * (opts.baseMs ?? 600) * 2 ** (attempt - 1));
    }
  }
}

export type ApiArea = 'household' | 'organiser' | 'offers' | 'console' | 'demo';

/**
 * Calls the api Function synchronously as the signed-in user, routed by
 * `area`. The platform attaches the caller's identity; nothing in `payload`
 * is trusted.
 */
export async function callFunction<T>(app: BrowserAppwrite, area: ApiArea, payload: { action: string } & Record<string, unknown>): Promise<T> {
  const operation = `${area}.${payload.action}`;
  const functionId = 'api';
  const execute = () =>
    app.log.run(`fn:${operation}`, () =>
      new Functions(app.client).createExecution({
        functionId,
        body: JSON.stringify({ area, ...payload }),
        async: false,
        method: ExecutionMethod.POST,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const execution = await withPlatformRetry(execute);
  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(execution.responseBody) as Envelope<T>;
  } catch {
    throw new FunctionError(operation, 'server', 'The service returned an unexpected response.', execution.responseStatusCode);
  }
  if (!envelope.ok) {
    throw new FunctionError(operation, envelope.error.code, envelope.error.message, execution.responseStatusCode, envelope.error.field);
  }
  return envelope.data;
}
