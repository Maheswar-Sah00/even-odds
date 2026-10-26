// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { safeErrorDetail } from '../../functions/shared/draw-runner.ts';
import { runFunction, type FunctionContext } from '../../functions/shared/function-runtime.ts';
import { consumeRateLimit, RATE_LIMITS, rateLimitRowId } from '../../functions/shared/rate-limit.ts';
import type { ServerDb } from '../../functions/shared/db.ts';
import { ServiceError, mapAppwriteError } from '../../shared/errors.ts';
import { parseSessionsCsv, parseZonesGeoJson } from '../../shared/program-input.ts';
import { computePlan, INPUTS_SCHEMA, type DrawInputs } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { withPlatformRetry } from '../../src/lib/appwrite/functions.ts';
import { canonicalFrozenInputs, FrozenInputsError, parseFrozenInputs, serializeFrozenInputs, summarizeFrozenInputs } from '../../shared/freeze/canonical.ts';

/**
 * Task 14 security hardening, offline: what reaches a client when server code
 * fails, malformed/hostile imports, and the per-caller rate limiter's logic.
 * The same behaviours are exercised against the deployed Function in
 * tests/integration/security.test.ts.
 */

// ---- error redaction ------------------------------------------------------------------

function fakeCtx(bodyText = '{}') {
  const out: { body?: unknown; status?: number; logs: string[] } = { logs: [] };
  const ctx: FunctionContext = {
    req: { headers: { 'x-appwrite-key': 'k', 'x-appwrite-user-id': 'u1' }, bodyText, method: 'POST' },
    res: { json: (body, status) => ((out.body = body), (out.status = status)) },
    log: (m) => out.logs.push(m),
    error: (m) => out.logs.push(m),
  };
  return { ctx, out };
}

describe('error responses never leak internals', () => {
  const env = { APPWRITE_FUNCTION_API_ENDPOINT: 'https://example.invalid/v1', APPWRITE_FUNCTION_PROJECT_ID: 'p', APPWRITE_DATABASE_ID: 'd' };
  afterEach(() => vi.unstubAllEnvs());
  const stub = () => { Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v)); };

  it('an unexpected exception becomes a generic 500; the message (paths, secrets) stays in the log', async () => {
    stub();
    const { ctx, out } = fakeCtx();
    await runFunction(ctx, () => Promise.reject(new Error('boom at /srv/app/main.js key=sk_live_123')));
    expect(out.status).toBe(500);
    expect(JSON.stringify(out.body)).not.toMatch(/boom|srv|sk_live|stack/);
    expect(out.body).toEqual({ ok: false, error: { code: 'server', message: 'Something went wrong on our side.' } });
    expect(out.logs.join('\n')).toMatch(/boom/);
  });

  it('a database error reports only a generic message (retryable ones as 503)', async () => {
    stub();
    const detail = 'Document with the requested ID could not be found. table=children row=abc123';
    for (const [code, type, status] of [[404, 'row_not_found', 500], [503, 'general_service_disabled', 503]] as const) {
      const { ctx, out } = fakeCtx();
      const err = new ServiceError('getRow(children)', mapAppwriteError(Object.assign(new Error(detail), { code, type })), detail);
      await runFunction(ctx, () => Promise.reject(err));
      expect(out.status).toBe(status);
      expect(JSON.stringify(out.body)).not.toMatch(/children|abc123|Document/);
    }
  });

  it('malformed JSON and the wrong method are validation errors, not crashes', async () => {
    stub();
    const bad = fakeCtx('{"area": "household",');
    await runFunction(bad.ctx, () => Promise.resolve('unreachable'));
    expect(bad.out).toMatchObject({ status: 400, body: { ok: false, error: { code: 'validation', message: 'The request body must be JSON.' } } });
    const get = fakeCtx();
    get.ctx.req.method = 'GET';
    await runFunction(get.ctx, () => Promise.resolve('unreachable'));
    expect(get.out.status).toBe(400);
  });

  it('guarded() results (manual runs, demo draws) carry a safe summary only', () => {
    expect(safeErrorDetail(new AppError('locked', 'Applications are frozen.'))).toBe('Applications are frozen.');
    expect(safeErrorDetail(new Error('INVARIANT VIOLATED: ledger lg_8f3 taken 5 > capacity 4'))).toBe('Internal error (details are in the Function log).');
    const svc = new ServiceError('commit', mapAppwriteError(Object.assign(new Error('raw platform text'), { code: 409, type: 'transaction_conflict' })), 'raw platform text');
    expect(safeErrorDetail(svc)).not.toMatch(/raw platform text/);
  });
});

// ---- hostile and malformed imports ----------------------------------------------------------

const HEADER = 'week,week_start,age_group,min_age,max_age,capacity,label';
const row = (label: string, cap = '10') => `W1,2027-06-21,6-8,6,8,${cap},${label}`;

describe('sessions CSV import (CSV injection and malformed files)', () => {
  it('refuses labels that a spreadsheet would run as a formula', () => {
    // (Cells are trimmed, so a leading tab or space cannot hide a prefix.)
    for (const label of ['"=HYPERLINK(""http://evil"",""x"")"', '+1+1', '-2+3', '@SUM(A1)', '"  =1+1"']) {
      const r = parseSessionsCsv(`${HEADER}\n${row(label)}\n`);
      expect(r.sessions, label).toEqual([]);
      expect(r.errors.some((e) => e.column === 'label'), label).toBe(true);
    }
    expect(parseSessionsCsv(`${HEADER}\n${row('Week 1: June 21 (ages 6-8)')}\n`).errors).toEqual([]);
  });

  it('refuses formula-like codes, out-of-range and non-integer capacities', () => {
    expect(parseSessionsCsv(`${HEADER}\n=1+1,2027-06-21,6-8,6,8,10,\n`).errors[0]?.column).toBe('week');
    for (const cap of ['-1', '10001', '2.5', '1e3', '0x10', '']) {
      expect(parseSessionsCsv(`${HEADER}\n${row('', cap)}\n`).errors.some((e) => e.column === 'capacity'), cap).toBe(true);
    }
  });

  it('bounds size and rejects garbage without throwing', () => {
    const many = Array.from({ length: 501 }, (_, i) => `W${String(i)},2027-06-21,6-8,6,8,1,`).join('\n');
    expect(parseSessionsCsv(`${HEADER}\n${many}\n`).errors[0]?.message).toMatch(/At most 500/);
    for (const junk of ['', '\u0000\u0001\u0002', '"unterminated', 'a,b\n1,2', '﻿\r\n\r\n', 'x'.repeat(100_000)]) {
      expect(() => parseSessionsCsv(junk)).not.toThrow();
      expect(parseSessionsCsv(junk).sessions).toEqual([]);
    }
  });
});

describe('zones GeoJSON import (malformed files)', () => {
  it('rejects hostile structures without throwing', () => {
    for (const junk of ['null', '[]', '{"type":"FeatureCollection"}', '{"type":"FeatureCollection","features":[null]}', '{"__proto__":{"polluted":1}}', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'x', tier: 1 }, geometry: { type: 'Polygon', coordinates: [[['a', 'b']]] } }] })]) {
      expect(() => parseZonesGeoJson(junk), junk).not.toThrow();
      expect(parseZonesGeoJson(junk).zones, junk).toEqual([]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ---- rate limiter --------------------------------------------------------------------------

/** In-memory stand-in with the two behaviours the limiter relies on (verified on Cloud): 404 for a missing row, a refused capped increment. */
function memoryDb() {
  const rows = new Map<string, number>();
  const svc = (code: number, type: string) => new ServiceError('op', mapAppwriteError(Object.assign(new Error(type), { code, type })));
  const db = {
    incrementRowColumn: (_t: string, id: string, _c: string, o: { value: number; max: number }) => {
      const v = rows.get(id);
      if (v === undefined) return Promise.reject(svc(404, 'row_not_found'));
      if (v + o.value > o.max) return Promise.reject(svc(400, 'column_limit_exceeded'));
      rows.set(id, v + o.value);
      return Promise.resolve({});
    },
    createRow: (_t: string, id: string, data: { count: number }) => {
      if (rows.has(id)) return Promise.reject(svc(409, 'row_already_exists'));
      rows.set(id, data.count);
      return Promise.resolve({});
    },
  };
  return { db: db as unknown as ServerDb, rows };
}

describe('per-caller rate limits', () => {
  it('allows exactly the limit per window, then refuses with rate_limited (429) and a wait time', async () => {
    const { db } = memoryDb();
    const now = Date.UTC(2027, 0, 1, 10, 15);
    const { limit } = RATE_LIMITS.invite;
    for (let i = 0; i < limit; i++) await consumeRateLimit(db, 'invite', 'user-a', now);
    const err = await consumeRateLimit(db, 'invite', 'user-a', now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('rate_limited');
    expect((err as AppError).status).toBe(429);
    expect((err as AppError).message).toMatch(/45 minutes/);
    // Another caller and the next window are unaffected.
    await expect(consumeRateLimit(db, 'invite', 'user-b', now)).resolves.toBeUndefined();
    await expect(consumeRateLimit(db, 'invite', 'user-a', now + 3600_000)).resolves.toBeUndefined();
  });

  it('concurrent first requests in a window all count (none is lost to the create race)', async () => {
    const { db, rows } = memoryDb();
    const now = Date.UTC(2027, 0, 1);
    await Promise.all(Array.from({ length: 8 }, () => consumeRateLimit(db, 'offers', 'user-c', now)));
    expect(rows.get(rateLimitRowId('offers', 'user-c', now))).toBe(8);
  });

  it('the identity bucket makes a birthdate search impractical (4,383 dates in 12 years)', () => {
    const { limit, windowMs } = RATE_LIMITS.identity;
    const days = (4383 / limit) * (windowMs / 86_400_000);
    expect(days).toBeGreaterThan(100);
  });
});

// ---- privacy of published draw inputs ---------------------------------------------------------

describe('draw-inputs-v2: overrides are published without reason or pool', () => {
  const v1: DrawInputs = { ...SAMPLE_INPUTS, overrides: SAMPLE_INPUTS.overrides.map((o) => ({ ...o })) };
  const v2: DrawInputs = { ...SAMPLE_INPUTS, schema: INPUTS_SCHEMA, overrides: SAMPLE_INPUTS.overrides.map((o) => ({ publicId: o.publicId })) };
  const seed = 'ab'.repeat(32);

  it('new freezes write v2, whose canonical text carries no reason or pool', () => {
    expect(INPUTS_SCHEMA).toBe('draw-inputs-v2');
    const text = serializeFrozenInputs(v2);
    expect(text).not.toMatch(/accommodation|reasonCode|"pool"/);
    expect(summarizeFrozenInputs(canonicalFrozenInputs(v2)).overrideCounts).toEqual({});
  });

  it('a v2 file that smuggles a reason or pool is refused', () => {
    const smuggled = { ...v2, overrides: [{ publicId: v2.overrides[0]?.publicId ?? '', reasonCode: 'accommodation', pool: 'accommodation' }] };
    expect(() => canonicalFrozenInputs(smuggled)).toThrow(FrozenInputsError);
  });

  it('the draw is identical: the reason never influenced allocation', () => {
    const a = computePlan(v1, seed);
    const b = computePlan(v2, seed);
    expect(b.order).toEqual(a.order);
    expect(b.steps).toEqual(a.steps);
    expect(b.waitlist).toEqual(a.waitlist);
  });

  it('programs frozen earlier (v1) still verify', () => {
    expect(() => parseFrozenInputs(serializeFrozenInputs(v1))).not.toThrow();
    expect(summarizeFrozenInputs(canonicalFrozenInputs(v1)).overrideCounts).toEqual({ accommodation: 1 });
  });
});

// ---- platform throttling in the browser client ------------------------------------------------

describe('browser Function calls retry platform throttling only', () => {
  const throttled = () => new ServiceError('fn:x', mapAppwriteError(Object.assign(new Error('Rate limit'), { code: 429, type: 'general_rate_limit_exceeded' })));
  const noSleep = () => Promise.resolve();

  it('retries a platform 429 (the Function never ran) and returns the eventual result', async () => {
    let calls = 0;
    const result = await withPlatformRetry(() => (++calls < 3 ? Promise.reject(throttled()) : Promise.resolve('ok')), { sleep: noSleep });
    expect([result, calls]).toEqual(['ok', 3]);
  });

  it('gives up after 4 attempts, and never retries other errors', async () => {
    let calls = 0;
    await expect(withPlatformRetry(() => { calls++; return Promise.reject(throttled()); }, { sleep: noSleep })).rejects.toBeInstanceOf(ServiceError);
    expect(calls).toBe(4);
    let other = 0;
    const conflict = new ServiceError('fn:x', mapAppwriteError(Object.assign(new Error('x'), { code: 409, type: 'row_already_exists' })));
    await expect(withPlatformRetry(() => { other++; return Promise.reject(conflict); }, { sleep: noSleep })).rejects.toBe(conflict);
    expect(other).toBe(1);
  });
});
