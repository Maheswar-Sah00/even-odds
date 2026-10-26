import { describe, expect, it } from 'vitest';
import { mapAppwriteError, toServiceError, ServiceError } from '../../shared/errors.ts';
import { createRequestLogger, redact, type RequestLogEntry } from '../../shared/log.ts';

// These are synthetic error objects shaped like AppwriteException; they test
// the mapping table only. Real error types are pinned by integration tests.
const aw = (code: number, type: string, message = 'x') => ({ code, type, message });

describe('mapAppwriteError', () => {
  it.each([
    [aw(404, 'database_not_found'), 'not_provisioned'],
    [aw(404, 'table_not_found'), 'not_provisioned'],
    [aw(404, 'project_not_found'), 'config'],
    [aw(409, 'row_already_exists'), 'conflict'],
    [aw(409, 'transaction_conflict'), 'transaction_conflict'],
    [aw(401, 'general_unauthorized_scope'), 'forbidden'],
    [aw(401, 'user_unauthorized'), 'forbidden'],
    [aw(401, 'user_session_not_found'), 'unauthorized'],
    [aw(429, 'general_rate_limit_exceeded'), 'rate_limited'],
    [aw(500, 'general_unknown'), 'server'],
    [aw(400, 'column_limit_exceeded'), 'capacity_exceeded'],
    [aw(400, 'attribute_limit_exceeded'), 'capacity_exceeded'],
    [aw(400, 'general_argument_invalid', 'exceeds maximum'), 'validation'],
  ])('maps %o to %s', (err, kind) => {
    expect(mapAppwriteError(err).kind).toBe(kind);
  });

  it('classifies fetch failures as network errors', () => {
    const mapped = mapAppwriteError(new TypeError('Failed to fetch'));
    expect(mapped).toMatchObject({ kind: 'network', status: 0, retryable: true });
  });

  it('never leaks unknown error messages to users', () => {
    const mapped = mapAppwriteError(new Error('secret internal detail'));
    expect(mapped.message).not.toContain('secret');
  });

  it('wraps once and keeps the raw detail separately', () => {
    const wrapped = toServiceError('op', aw(404, 'table_not_found', 'Table with the requested ID could not be found.'));
    expect(wrapped).toBeInstanceOf(ServiceError);
    expect(wrapped.detail).toMatch(/could not be found/);
    expect(toServiceError('other', wrapped)).toBe(wrapped);
  });
});

describe('request logger', () => {
  it('records outcome without payloads and rethrows as ServiceError', async () => {
    const entries: RequestLogEntry[] = [];
    const log = createRequestLogger('test', (e) => entries.push(e));
    await expect(log.run('createRow', () => Promise.resolve({ email: 'a@b.c' }))).resolves.toEqual({ email: 'a@b.c' });
    await expect(log.run('getRow', () => Promise.reject(Object.assign(new Error('x'), aw(404, 'row_not_found'))))).rejects.toBeInstanceOf(ServiceError);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ operation: 'getRow', ok: false, errorKind: 'not_found', status: 404 });
    expect(JSON.stringify(entries)).not.toContain('a@b.c');
  });

  it('redacts sensitive keys recursively', () => {
    expect(redact({ apiKey: 'k', nested: { birthdate: '2019-01-01', week: 'W1' } })).toEqual({
      apiKey: '[redacted]',
      nested: { birthdate: '[redacted]', week: 'W1' },
    });
  });
});
