import { Query } from 'node-appwrite';
import { AppError } from './app-error.ts';
import { deterministicId, sha256Hex } from './crypto.ts';
import type { ServerDb } from './db.ts';
import { isKind } from './household.ts';

/**
 * Per-caller fixed-window limits for sensitive api actions (Task 14). One row
 * per (bucket, caller, window) with a deterministic ID; the count is raised
 * with incrementRowColumn({ max: limit }), which the database refuses at the
 * cap (column_limit_exceeded, verified in docs/VERIFIED-BEHAVIOUR.md), so
 * concurrent requests cannot exceed the limit. Email codes (OTP) are limited
 * by Appwrite itself; see docs/TEST-REPORT.md.
 */
export const RATE_LIMITS = {
  /** Adding, editing or registering a child: each reveals whether the identity already holds a ticket elsewhere. */
  identity: { limit: 30, windowMs: 24 * 3600_000 },
  /** Application submissions and withdrawals. */
  application: { limit: 30, windowMs: 3600_000 },
  /** Invite code attempts (accepting) and creation. */
  invite: { limit: 10, windowMs: 3600_000 },
  /** Household creation and home-location changes. */
  household: { limit: 20, windowMs: 3600_000 },
  /** Replies to offers. */
  offers: { limit: 60, windowMs: 3600_000 },
} as const;
export type RateBucket = keyof typeof RATE_LIMITS;

export const rateLimitRowId = (bucket: RateBucket, subject: string, windowStart: number) => deterministicId('rl', bucket, subject, String(windowStart));

export async function consumeRateLimit(db: ServerDb, bucket: RateBucket, subject: string, now = Date.now()): Promise<void> {
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const rowId = rateLimitRowId(bucket, subject, windowStart);
  const refuse = () => {
    const minutes = Math.max(1, Math.ceil((windowStart + windowMs - now) / 60_000));
    return new AppError('rate_limited', `Too many attempts. Please try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`);
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.incrementRowColumn('rate_limits', rowId, 'count', { value: 1, max: limit });
      return;
    } catch (err) {
      if (isKind(err, 'capacity_exceeded')) throw refuse();
      if (!isKind(err, 'not_found')) throw err;
    }
    try {
      await db.createRow('rate_limits', rowId, { bucket, subject_hash: sha256Hex(subject), window_start: new Date(windowStart).toISOString(), count: 1 });
      return;
    } catch (err) {
      // A concurrent first request created the row: count this one against it.
      if (!isKind(err, 'conflict')) throw err;
    }
  }
  throw refuse();
}

/** Deletes counters whose window ended more than a day ago (run by the jobs Function). */
export async function pruneRateLimits(db: ServerDb, now = Date.now()) {
  const longest = Math.max(...Object.values(RATE_LIMITS).map((r) => r.windowMs));
  await db.deleteRowsWhere('rate_limits', [Query.lessThan('window_start', new Date(now - longest - 24 * 3600_000).toISOString())]);
}
