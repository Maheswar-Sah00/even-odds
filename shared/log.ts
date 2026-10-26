import { toServiceError } from './errors.ts';

/**
 * Request logging that records what happened, never what was sent: operation
 * name, duration, outcome and error classification. Payloads are not logged.
 */
export interface RequestLogEntry {
  at: string;
  scope: string;
  operation: string;
  ms: number;
  ok: boolean;
  errorKind?: string;
  errorType?: string;
  status?: number;
}

export type LogSink = (entry: RequestLogEntry) => void;

const SENSITIVE_KEY = /key|secret|token|password|session|jwt|cookie|email|phone|name|birth|home|address|lat|lng/i;

/** Redact values whose keys look sensitive; use for any ad-hoc context that must be logged. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v: unknown) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

export interface RequestLogger {
  /** Run an Appwrite call, record a log entry, and rethrow failures as ServiceError. */
  run<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  recent(): readonly RequestLogEntry[];
}

export function createRequestLogger(scope: string, sink?: LogSink, capacity = 50): RequestLogger {
  const buffer: RequestLogEntry[] = [];
  const record = (entry: RequestLogEntry) => {
    buffer.push(entry);
    if (buffer.length > capacity) buffer.shift();
    sink?.(entry);
  };

  return {
    async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
      const started = performance.now();
      const at = new Date().toISOString();
      try {
        const result = await fn();
        record({ at, scope, operation, ms: Math.round(performance.now() - started), ok: true });
        return result;
      } catch (err) {
        const serviceError = toServiceError(operation, err);
        const { kind, type, status } = serviceError.mapped;
        record({
          at,
          scope,
          operation,
          ms: Math.round(performance.now() - started),
          ok: false,
          errorKind: kind,
          ...(type === undefined ? {} : { errorType: type }),
          ...(status === undefined ? {} : { status }),
        });
        throw serviceError;
      }
    },
    recent: () => [...buffer],
  };
}

export const consoleSink: LogSink = (e) => {
  const outcome = e.ok ? 'ok' : `FAILED ${e.errorKind ?? ''}${e.errorType ? ` (${e.errorType})` : ''}`;
  const line = `[${e.scope}] ${e.operation} ${outcome} ${e.ms}ms`;
  if (e.ok) console.info(line);
  else console.warn(line);
};
