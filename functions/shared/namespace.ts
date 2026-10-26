import { AppError } from './app-error.ts';
import type { Row } from './db.ts';

/**
 * Demo/production separation (Task 12), enforced on the server in BOTH
 * directions:
 *
 * - Production paths (organiser, console and offers areas, manual jobs) call
 *   assertProduction(): a demo sandbox looks like it does not exist there.
 * - Demo paths (the "demo" area) never take a program ID from the client.
 *   They derive the caller's sandbox from the platform-set user ID and call
 *   assertSandboxOf() before every read or write, so a demo control can
 *   only ever touch the caller's own demo program, never production data.
 *
 * Demo programs are also private to their visitor (row reads are granted to
 * a per-sandbox Team), synthetic, and use the demo timing profile
 * (shared/freeze/protocol.ts).
 */

export type Scope = 'production' | 'demo';

export const isDemo = (program: Pick<Row<'programs'>, 'namespace'>): boolean => program.namespace === 'demo';

/** Production paths: demo programs are invisible (same error as a missing program). */
export function assertProduction(program: Pick<Row<'programs'>, 'namespace'>): void {
  if (isDemo(program)) throw new AppError('not_found', 'Program not found.');
}

/** Demo paths: only the caller's own demo sandbox, never a production program. */
export function assertSandboxOf(program: Pick<Row<'programs'>, 'namespace' | 'sandbox_owner' | 'synthetic'>, ownerId: string): void {
  if (!isDemo(program) || program.sandbox_owner !== ownerId || !program.synthetic) throw new AppError('not_found', 'Demo sandbox not found. Start a new demo.');
}

/** A program as seen by the code path in `scope`. */
export function assertScope(program: Pick<Row<'programs'>, 'namespace'>, scope: Scope): void {
  if (scope === 'production') assertProduction(program);
  else if (!isDemo(program)) throw new AppError('not_found', 'Program not found.');
}
