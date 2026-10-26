import { Query } from 'appwrite';
import { fetchBeaconFromRelays, roundTimeMs, SEED_SCHEME } from '@shared/freeze/drand.ts';
import { BUNDLE_FORMAT, replayBundle, type ReplayBundle, type ReplayOptions, type Verification } from '@shared/replay/index.ts';
import type { BrowserDb, BrowserRow } from '../../lib/appwrite/db.ts';

/**
 * Independent verification in the browser. Loads the PUBLIC rows into a
 * replay bundle (shared/replay/bundle.ts) and hands it to the pure replay
 * (shared/replay/replay.ts), which recomputes everything with the same shared
 * code the server ran and asks drand itself for the beacon (docs/REPLAY.md).
 * Nothing the server reports about itself is taken on trust, except where a
 * step says so (server timestamps).
 */

export interface PublishedRecord {
  program: BrowserRow<'programs'>;
  snapshot: BrowserRow<'frozen_inputs'> | null;
  run: BrowserRow<'draw_runs'> | null;
  audit: BrowserRow<'audit_log'>[];
  result: BrowserRow<'draw_results'> | null;
}

export async function loadPublished(db: BrowserDb, programId: string): Promise<PublishedRecord> {
  const [program, snapshots, runs, results] = await Promise.all([
    db.getRow('programs', programId),
    db.listRows('frozen_inputs', [Query.equal('program_id', programId), Query.limit(1)]),
    db.listRows('draw_runs', [Query.equal('program_id', programId), Query.orderDesc('$createdAt'), Query.limit(25)]),
    db.listRows('draw_results', [Query.equal('program_id', programId), Query.limit(1)]),
  ]);
  const audit: BrowserRow<'audit_log'>[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listRows('audit_log', [Query.equal('program_id', programId), Query.orderAsc('seq'), Query.limit(100), Query.offset(offset)]);
    audit.push(...page.rows);
    if (page.rows.length < 100) break;
  }
  // The protocol run is the one created at freeze (it carries the seed scheme).
  const run = runs.rows.find((r) => r.seed_scheme === SEED_SCHEME) ?? runs.rows[0] ?? null;
  return { program, snapshot: snapshots.rows[0] ?? null, run, audit, result: results.rows[0] ?? null };
}

export type DrawPhase = 'not_frozen' | 'awaiting_round' | 'beacon_pending' | 'drawing' | 'drawn' | 'failed';

/** Public draw status, in words, from public rows only. */
export function drawPhase(rec: PublishedRecord, now = Date.now()): { phase: DrawPhase; label: string } {
  const { program, snapshot, run } = rec;
  if (!snapshot || program.status === 'draft' || program.status === 'open') return { phase: 'not_frozen', label: 'Inputs not frozen yet' };
  if (run?.status === 'failed') return { phase: 'failed', label: 'Draw stopped: the database refused a planned step' };
  if (run?.status === 'completed' || program.status === 'drawn' || program.status === 'closed') return { phase: 'drawn', label: 'Drawn' };
  if (run?.seed) return { phase: 'drawing', label: 'Beacon verified; placements being committed' };
  if (now < roundTimeMs(snapshot.drand_round)) return { phase: 'awaiting_round', label: `Frozen; waiting for drand round ${String(snapshot.drand_round)}` };
  return { phase: 'beacon_pending', label: 'Frozen; drand round published, awaiting verification by the server' };
}

/** ISO 8601 UTC with milliseconds and "Z" (Appwrite returns "+00:00"). */
const iso = (value: string) => new Date(value).toISOString();

/** The public artifacts as a self-contained bundle. Raw values only: no server verdict is copied in. */
export function bundleFromRecord(rec: PublishedRecord, exportedAt = new Date()): ReplayBundle {
  const { program, snapshot, run, result } = rec;
  return {
    format: BUNDLE_FORMAT,
    exportedAt: exportedAt.toISOString(),
    program: {
      id: program.$id,
      namespace: program.namespace ?? null,
      status: program.status,
      windowClose: iso(program.window_close),
      drandRound: program.drand_round ?? null,
      drandChain: program.drand_chain ?? null,
      inputsHash: program.inputs_hash ?? null,
    },
    snapshot: snapshot
      ? {
          canonical: snapshot.canonical,
          inputsHash: snapshot.inputs_hash,
          frozenAt: iso(snapshot.frozen_at),
          drandRound: snapshot.drand_round,
          drandChain: snapshot.drand_chain,
          counts: { applications: snapshot.applications, children: snapshot.children, sessions: snapshot.sessions, seats: snapshot.seats, overrides: snapshot.overrides, overrideCounts: snapshot.override_counts },
          applicationOrder: snapshot.application_order ?? null,
          applicationOrderHash: snapshot.application_order_hash ?? null,
        }
      : null,
    run: run
      ? {
          id: run.$id,
          status: run.status,
          drandRound: run.drand_round,
          inputsHash: run.inputs_hash,
          seedScheme: run.seed_scheme ?? null,
          seed: run.seed ?? null,
          planHash: run.plan_hash ?? null,
          beaconRandomness: run.beacon_randomness ?? null,
          beaconSignature: run.beacon_signature ?? null,
          cursor: run.cursor,
          error: run.error ?? null,
        }
      : null,
    beacon: null,
    result: result
      ? { canonical: result.canonical, resultHash: result.result_hash, drawRunId: result.draw_run_id, placements: result.placements, waitlist: result.waitlist, outcomes: result.outcomes ?? null, outcomesAt: result.outcomes_at ? iso(result.outcomes_at) : null }
      : null,
    audit: rec.audit.map((a) => ({ seq: a.seq, event: a.event, payload: a.payload, payload_hash: a.payload_hash, prev_hash: a.prev_hash, entry_hash: a.entry_hash })),
  };
}

export const loadBundle = async (db: BrowserDb, programId: string): Promise<ReplayBundle> => bundleFromRecord(await loadPublished(db, programId));

/**
 * Loads and verifies a program, asking drand directly for the beacon. The
 * returned bundle carries the beacon that was verified, so a download replays
 * offline exactly as here.
 */
export async function verifyProgram(db: BrowserDb, programId: string, opts: ReplayOptions = {}): Promise<{ bundle: ReplayBundle; verification: Verification }> {
  const bundle = await loadBundle(db, programId);
  const verification = await replayBundle(bundle, { fetchBeacon: (r) => fetchBeaconFromRelays(r), ...opts });
  const b = verification.beacon;
  return { bundle: b ? { ...bundle, beacon: { ...b.beacon, source: b.source } } : bundle, verification };
}
