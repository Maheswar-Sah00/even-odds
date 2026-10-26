/**
 * Errors that server code raises deliberately. Their messages are written for
 * end users and are safe to return to the browser. Anything else is reported
 * to the caller as a generic server error.
 */
export type AppErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'validation' | 'conflict' | 'locked' | 'expired' | 'rate_limited';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  conflict: 409,
  locked: 423,
  expired: 410,
  rate_limited: 429,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly field: string | undefined;

  constructor(code: AppErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.field = field;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}
