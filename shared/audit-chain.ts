import { sha256Hex } from './draw/sha256.ts';

/**
 * The audit log's hash chain, pure and isomorphic: the server writer
 * (functions/shared/audit.ts) and the public browser verifier use this file.
 *
 *   payload_hash = SHA-256(payload)
 *   entry_hash   = SHA-256(prev_hash "\n" seq "\n" event "\n" payload_hash)
 *   prev_hash    = previous entry_hash, or "0" x 64 for seq 1
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  seq: number;
  event: string;
  payload: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
}

export function entryHash(prevHash: string, seq: number, event: string, payloadHash: string): string {
  return sha256Hex([prevHash, String(seq), event, payloadHash].join('\n'));
}

/** Verifies seq continuity, payload hashes and the hash chain. Entries in any order. */
export function verifyChain(entries: readonly AuditEntry[]): { ok: true } | { ok: false; seq: number; reason: string } {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS_HASH;
  for (const [i, e] of sorted.entries()) {
    if (e.seq !== i + 1) return { ok: false, seq: e.seq, reason: `expected seq ${String(i + 1)}` };
    if (sha256Hex(e.payload) !== e.payload_hash) return { ok: false, seq: e.seq, reason: 'payload hash mismatch' };
    if (e.prev_hash !== prev) return { ok: false, seq: e.seq, reason: 'prev_hash does not match previous entry' };
    if (entryHash(e.prev_hash, e.seq, e.event, e.payload_hash) !== e.entry_hash) return { ok: false, seq: e.seq, reason: 'entry hash mismatch' };
    prev = e.entry_hash;
  }
  return { ok: true };
}

// ---- Full integrity report (Task 13) -------------------------------------------------

export type AuditIssueKind = 'malformed' | 'duplicate' | 'missing' | 'payload_altered' | 'entry_altered' | 'link_broken' | 'payload_not_json';

export interface AuditIssue {
  /** null when the record is too malformed to have a usable seq. */
  seq: number | null;
  kind: AuditIssueKind;
  message: string;
}

export interface AuditIntegrity {
  ok: boolean;
  /** Records received. */
  records: number;
  /** Records whose own hashes and link to the previous entry all check out. */
  verified: number;
  /** Highest seq seen, and the entry hash at the end of the intact prefix (compare it with a value you noted earlier). */
  lastSeq: number;
  head: string | null;
  issues: AuditIssue[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function malformedReason(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'the record is not an object';
  const r = raw as Partial<Record<keyof AuditEntry, unknown>>;
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) return 'seq is not a positive integer';
  if (typeof r.event !== 'string' || !/^[a-z0-9_]{1,64}$/.test(r.event)) return 'event is not a 1-64 character event name';
  if (typeof r.payload !== 'string') return 'payload is not text';
  for (const k of ['payload_hash', 'prev_hash', 'entry_hash'] as const) {
    if (typeof r[k] !== 'string' || !HEX64.test(r[k])) return `${k} is not 64 lowercase hex characters`;
  }
  return null;
}

/**
 * Checks EVERY record and reports every problem (verifyChain stops at the
 * first): malformed records, duplicate or missing sequence numbers, payloads
 * whose text no longer matches their hash, entries whose own hash does not
 * match their fields, and links that do not point at the previous entry.
 *
 * This proves the records have not been altered, removed or reordered since
 * they were written. It cannot prove that what an organiser entered was true,
 * nor detect entries cut off the END of the log (compare `head` with a value
 * recorded earlier, or with events the other artifacts require).
 */
export function auditIntegrity(records: readonly unknown[]): AuditIntegrity {
  const issues: AuditIssue[] = [];
  const bySeq = new Map<number, AuditEntry[]>();
  for (const raw of records) {
    const reason = malformedReason(raw);
    if (reason) {
      const seq = (raw as { seq?: unknown } | null)?.seq;
      issues.push({ seq: Number.isSafeInteger(seq) ? (seq as number) : null, kind: 'malformed', message: `Malformed record: ${reason}.` });
      continue;
    }
    const e = raw as AuditEntry;
    bySeq.set(e.seq, [...(bySeq.get(e.seq) ?? []), e]);
  }

  const lastSeq = Math.max(0, ...bySeq.keys());
  let verified = 0;
  let head: string | null = null;
  let intact = true;
  let prev: AuditEntry | null = null;
  for (let seq = 1; seq <= lastSeq; seq++) {
    const found = bySeq.get(seq) ?? [];
    if (found.length === 0) {
      issues.push({ seq, kind: 'missing', message: `Entry ${String(seq)} is missing: the log jumps from ${String(seq - 1)} to a later entry, so a record was removed or never published.` });
      intact = false;
      prev = null;
      continue;
    }
    if (found.length > 1) {
      issues.push({ seq, kind: 'duplicate', message: `There are ${String(found.length)} different records numbered ${String(seq)}: the log has been forked.` });
      intact = false;
    }
    for (const e of found) {
      let ok = true;
      if (sha256Hex(e.payload) !== e.payload_hash) {
        issues.push({ seq, kind: 'payload_altered', message: `Entry ${String(seq)} (${e.event}): the payload text does not match its recorded hash, so the payload was changed after it was written.` });
        ok = false;
      }
      try {
        JSON.parse(e.payload);
      } catch {
        issues.push({ seq, kind: 'payload_not_json', message: `Entry ${String(seq)} (${e.event}): the payload is not valid JSON.` });
        ok = false;
      }
      if (entryHash(e.prev_hash, e.seq, e.event, e.payload_hash) !== e.entry_hash) {
        issues.push({ seq, kind: 'entry_altered', message: `Entry ${String(seq)} (${e.event}): its hash does not match its own number, event name and payload hash, so one of them was changed.` });
        ok = false;
      }
      const expectedPrev = seq === 1 ? GENESIS_HASH : prev?.entry_hash;
      if (expectedPrev !== undefined && e.prev_hash !== expectedPrev) {
        issues.push({
          seq,
          kind: 'link_broken',
          message: seq === 1 ? 'Entry 1 does not start the chain (its previous hash is not the all-zero genesis value).' : `Entry ${String(seq)} (${e.event}) does not link to entry ${String(seq - 1)}: an earlier entry was replaced or this one was inserted.`,
        });
        ok = false;
      }
      if (ok && found.length === 1 && expectedPrev !== undefined) verified++;
      if (!ok) intact = false;
    }
    prev = found.length === 1 ? (found[0] ?? null) : null;
    if (intact && prev) head = prev.entry_hash;
  }
  return { ok: issues.length === 0, records: records.length, verified, lastSeq, head, issues };
}
