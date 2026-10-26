import { ServiceError } from '../../shared/errors.ts';
import { AppError } from './app-error.ts';
import type { Row, ServerDb } from './db.ts';

/**
 * The ONLY way program status changes (except creation as "draft").
 *
 *   draft --publish--> open --freeze--> frozen --draw complete--> drawn --> closed
 *
 * Write locks that hang off status (enforced server-side where each write happens):
 * - open: applications can be submitted, edited and withdrawn
 *   (applicationWindow in household.ts); capacity can be raised (setCapacity).
 * - frozen / drawn / closed: applications, child edits, tickets and capacity are locked.
 * - draft only: program details, sessions and zones can change (organiser.ts).
 *
 * The update runs inside a TablesDB transaction, so two concurrent transitions
 * of the same program cannot both succeed (the loser gets transaction_conflict,
 * verified behaviour) and the caller sees `conflict`.
 */
export type ProgramStatus = Row<'programs'>['status'];

const ALLOWED: Record<ProgramStatus, readonly ProgramStatus[]> = {
  draft: ['open'],
  open: ['frozen'],
  frozen: ['drawn'],
  drawn: ['closed'],
  closed: [],
};

export function canTransition(from: ProgramStatus, to: ProgramStatus): boolean {
  return ALLOWED[from].includes(to);
}

export async function transitionProgram(
  db: ServerDb,
  programId: string,
  to: ProgramStatus,
  extra: Partial<Row<'programs'>> & { permissions?: string[] } = {},
  opts: {
    /**
     * Stages further writes in the SAME transaction as the status change, so
     * they commit or roll back together (the freeze stages its snapshot, draw
     * run and audit entry here).
     */
    stage?: (transactionId: string, program: Row<'programs'>) => Promise<void>;
  } = {},
): Promise<Row<'programs'>> {
  const program = await db.getRow('programs', programId).catch((err: unknown) => {
    if (err instanceof ServiceError && err.mapped.kind === 'not_found') throw new AppError('not_found', 'Program not found.');
    throw err;
  });
  if (!canTransition(program.status, to)) {
    throw new AppError('locked', `A program cannot move from "${program.status}" to "${to}".`);
  }
  const { permissions, ...fields } = extra;
  const data = Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith('$')));
  const tx = await db.transactions.begin(60);
  try {
    await db.updateRow('programs', programId, { ...data, status: to }, { transactionId: tx.$id, ...(permissions ? { permissions } : {}) });
    if (opts.stage) await opts.stage(tx.$id, program);
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
  } catch (err) {
    if (err instanceof ServiceError && err.mapped.kind === 'transaction_conflict') {
      throw new AppError('conflict', 'The program changed at the same time. Reload and try again.');
    }
    throw err;
  }
  return db.getRow('programs', programId);
}
