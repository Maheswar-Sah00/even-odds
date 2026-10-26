/**
 * Maps errors from either Appwrite SDK (or fetch) into a small, UI-safe shape.
 * Duck-typed so it works with `appwrite` and `node-appwrite` exceptions and
 * keeps this module free of SDK imports.
 */
export type ErrorKind =
  | 'network' // endpoint unreachable, DNS, CORS, offline
  | 'config' // project or endpoint misconfigured
  | 'not_provisioned' // database or table missing: run db:provision
  | 'unauthorized' // no session / session expired
  | 'forbidden' // authenticated but lacks permission or key scope
  | 'not_found'
  | 'conflict' // unique index violation, row exists
  | 'transaction_conflict' // optimistic transaction conflict; retry with jitter
  | 'capacity_exceeded' // capped counter refused the increment
  | 'rate_limited'
  | 'validation'
  | 'server'
  | 'unknown';

export interface MappedError {
  kind: ErrorKind;
  /** HTTP status from Appwrite, 0 for network failures, undefined if unknown. */
  status: number | undefined;
  /** Appwrite error type string (e.g. "row_already_exists"), if any. */
  type: string | undefined;
  /** Message safe to show to users; never includes payloads or secrets. */
  message: string;
  retryable: boolean;
}

interface AppwriteLike {
  code: number;
  type?: string;
  message: string;
}

export function isAppwriteLike(err: unknown): err is AppwriteLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'number' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

const NETWORK_MESSAGE =
  'Could not reach the Appwrite endpoint. Check the endpoint URL, your connection, and that this site is registered as a Web app in the Appwrite console (CORS).';

/**
 * Capped-counter refusals from incrementRowColumn({ max }), observed on
 * Appwrite Cloud (docs/VERIFIED-BEHAVIOUR.md):
 *  - direct call:          400 column_limit_exceeded
 *  - at transaction commit: 400 attribute_limit_exceeded
 * Pinned by tests/integration/invariants.test.ts.
 */
const CAPACITY_TYPES = new Set(['column_limit_exceeded', 'attribute_limit_exceeded']);

export function isCapacityError(err: { type?: string | undefined; message: string }): boolean {
  return CAPACITY_TYPES.has(err.type ?? '');
}

const forbidden = 'You do not have permission to do that.';
const rateLimited = 'Too many requests. Please wait a moment and retry.';

export function mapAppwriteError(err: unknown): MappedError {
  if (!isAppwriteLike(err)) {
    const isFetchFailure = err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
    return isFetchFailure
      ? { kind: 'network', status: 0, type: undefined, message: NETWORK_MESSAGE, retryable: true }
      : { kind: 'unknown', status: undefined, type: undefined, message: 'An unexpected error occurred.', retryable: false };
  }

  const { code, type, message } = err;
  const base = { status: code, type };

  if (code === 0 || /failed to fetch|network ?error|fetch failed/i.test(message)) {
    return { ...base, kind: 'network', message: NETWORK_MESSAGE, retryable: true };
  }
  if (isCapacityError(err)) {
    return { ...base, kind: 'capacity_exceeded', message: 'No seats left for this session.', retryable: false };
  }
  switch (type) {
    case 'project_not_found':
    case 'project_unknown':
      return { ...base, kind: 'config', message: 'The Appwrite project ID is not recognised by this endpoint.', retryable: false };
    case 'api_key_invalid':
      return { ...base, kind: 'config', message: 'The server API key is not valid for this project.', retryable: false };
    case 'database_not_found':
    case 'table_not_found':
    case 'collection_not_found':
      return { ...base, kind: 'not_provisioned', message: 'The database schema is not set up yet. Run `npm run db:provision`.', retryable: false };
    case 'transaction_conflict':
      return { ...base, kind: 'transaction_conflict', message: 'Another update happened at the same time. Please retry.', retryable: true };
    case 'general_rate_limit_exceeded':
      return { ...base, kind: 'rate_limited', message: rateLimited, retryable: true };
    case 'general_unauthorized_scope':
    case 'user_unauthorized':
      return { ...base, kind: 'forbidden', message: forbidden, retryable: false };
  }
  if (code === 409) return { ...base, kind: 'conflict', message: 'That record already exists.', retryable: false };
  if (code === 401) return { ...base, kind: 'unauthorized', message: 'Please sign in to continue.', retryable: false };
  if (code === 403) return { ...base, kind: 'forbidden', message: forbidden, retryable: false };
  if (code === 404) return { ...base, kind: 'not_found', message: 'Not found.', retryable: false };
  if (code === 400) return { ...base, kind: 'validation', message: 'The request was rejected as invalid.', retryable: false };
  if (code === 429) return { ...base, kind: 'rate_limited', message: rateLimited, retryable: true };
  if (code >= 500) return { ...base, kind: 'server', message: 'Appwrite reported a server error. Please retry.', retryable: true };
  return { ...base, kind: 'unknown', message: 'An unexpected error occurred.', retryable: false };
}

/** Error thrown by the service layers: carries the mapped error and the operation name. */
export class ServiceError extends Error {
  readonly mapped: MappedError;
  readonly operation: string;
  /** Raw Appwrite message for diagnostics; may contain IDs, never secrets. */
  readonly detail: string | undefined;

  constructor(operation: string, mapped: MappedError, detail?: string) {
    super(mapped.message);
    this.name = 'ServiceError';
    this.operation = operation;
    this.mapped = mapped;
    this.detail = detail;
  }
}

export function toServiceError(operation: string, err: unknown): ServiceError {
  if (err instanceof ServiceError) return err;
  return new ServiceError(operation, mapAppwriteError(err), isAppwriteLike(err) ? err.message : undefined);
}
