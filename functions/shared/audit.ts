import { Query } from 'node-appwrite';
import { ServiceError } from '../../shared/errors.ts';
import { GENESIS_HASH, entryHash, type AuditEntry } from '../../shared/audit-chain.ts';
import { canonicalJson, deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { sleepBackoff, type RetryOptions } from './retry.ts';

/**
 * Append-only, hash-chained public audit log.
 *
 * Append-only through the application API: this module exports no update or
 * delete; the audit_log table grants clients read only (no create/update/
 * delete), so no user session can alter it. The unique index (program_id,
 * seq) plus a deterministic row ID per (program, seq) stops two writers from
 * forking the chain. Holders of the server API key can still modify rows
 * directly; the hash chain makes any such edit detectable by verifyChain().
 */

export { GENESIS_HASH, entryHash, verifyChain, type AuditEntry } from '../../shared/audit-chain.ts';

/** Keys that could carry personal data; audit payloads must use pseudonymous IDs only. */
const FORBIDDEN_KEY = /name|birth|email|phone|address|^home|^lat|^lng|^lon$|child_key|user_id|(^|_)ip$/i;

export function assertPseudonymous(payload: unknown, path = 'payload'): void {
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => {
      assertPseudonymous(v, `${path}[${i}]`);
    });
    return;
  }
  if (payload !== null && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (FORBIDDEN_KEY.test(k)) throw new Error(`Audit payload must not contain personal data: ${path}.${k}`);
      assertPseudonymous(v, `${path}.${k}`);
    }
  }
}

/** The next entry for a program (read from the current head), plus its deterministic row ID. */
export async function prepareAudit(
  db: ServerDb,
  input: { programId: string; event: string; payload: Record<string, unknown> },
): Promise<{ rowId: string; entry: AuditEntry }> {
  assertPseudonymous(input.payload);
  const payload = canonicalJson(input.payload);
  const payloadHash = sha256Hex(payload);
  const { rows } = await db.listRows('audit_log', [Query.equal('program_id', input.programId), Query.orderDesc('seq'), Query.limit(1)]);
  const last = rows[0];
  const seq = (last?.seq ?? 0) + 1;
  const prev = last?.entry_hash ?? GENESIS_HASH;
  return {
    rowId: deterministicId('au', input.programId, String(seq)),
    entry: { seq, event: input.event, payload, payload_hash: payloadHash, prev_hash: prev, entry_hash: entryHash(prev, seq, input.event, payloadHash) },
  };
}

/** The first entry of `event` for a program, if any. */
export async function findAuditEvent(db: ServerDb, programId: string, event: string): Promise<Row<'audit_log'> | null> {
  const { rows } = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.equal('event', event), Query.orderAsc('seq'), Query.limit(1)]);
  return rows[0] ?? null;
}

export async function appendAudit(
  db: ServerDb,
  input: { programId: string; event: string; payload: Record<string, unknown> },
  retry: RetryOptions = {},
): Promise<AuditEntry> {
  const maxAttempts = retry.maxAttempts ?? 8;

  for (let attempt = 1; ; attempt++) {
    const { rowId, entry } = await prepareAudit(db, input);
    try {
      await db.createRow('audit_log', rowId, { program_id: input.programId, ...entry });
      return entry;
    } catch (err) {
      // Another writer took this seq: re-read the head and try again.
      if (err instanceof ServiceError && err.mapped.kind === 'conflict' && attempt < maxAttempts) {
        await sleepBackoff(attempt, { baseDelayMs: 50, ...retry });
        continue;
      }
      throw err;
    }
  }
}
