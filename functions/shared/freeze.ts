import { Query } from 'node-appwrite';
import { DRAW_ALGORITHM, type DrawInputs } from '../../shared/draw/index.ts';
import { ServiceError } from '../../shared/errors.ts';
import { applicationOrderOf, artifactHash, serializeApplicationOrder } from '../../shared/replay/result.ts';
import { FROZEN_FORMAT, FrozenInputsError, frozenInputsHash, parseFrozenInputs, serializeFrozenInputs, summarizeFrozenInputs, type FrozenSummary } from '../../shared/freeze/canonical.ts';
import {
  announcedRound,
  deriveSeed,
  DRAND_CHAIN,
  DRAND_VERIFIER,
  fetchBeaconFromRelays,
  freezeDeadlineMs,
  roundTimeMs,
  SEED_SCHEME,
  TIMING,
  timingOf,
  verifyBeacon,
  type BeaconFetch,
} from '../../shared/freeze/drand.ts';
import { AppError } from './app-error.ts';
import { appendAudit, findAuditEvent, prepareAudit } from './audit.ts';
import { deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { buildDrawInputs, type DrawContext } from './draw-commit.ts';
import { allRows, findRow } from './household.ts';
import { idempotencyRowId } from './placement.ts';
import { transitionProgram } from './program-status.ts';
import { sleepBackoff } from './retry.ts';

/**
 * Freeze-and-verify protocol (docs/FREEZE-PROTOCOL.md).
 *
 * 1. Announce: at publish the program commits to a drand round derived from
 *    its window close (announcedRound), on a pinned chain.
 * 2. Freeze: after applications close and well before that round exists, the
 *    eligible inputs are validated, serialized canonically, hashed and
 *    published in ONE transaction with the open -> frozen transition, a
 *    pending draw run and the `inputs_frozen` audit entry. Deterministic row
 *    IDs make the freeze idempotent: a repeated or concurrent freeze can only
 *    ever find the one snapshot that committed.
 * 3. Beacon: once the round is due, the beacon is fetched, its BLS signature
 *    verified against the pinned key, and the seed derived. Any failure leaves
 *    the draw pending; there is no fallback source of randomness.
 * 4. Draw: only from the frozen snapshot and a seed whose provenance re-verifies.
 */

export const frozenInputsRowId = (programId: string) => deterministicId('fz', 'frozen', programId);
export const protocolDrawRunId = (programId: string) => deterministicId('dr', 'draw', programId);

/** With a late policy, the scheduled freeze waits until this long before the freeze deadline (still >= one hourly tick of slack). */
export const LATE_AUTO_FREEZE_LEAD_MS = 75 * 60_000;

export interface FreezeResult {
  status: 'frozen' | 'already_frozen';
  programId: string;
  format: string;
  algorithm: string;
  inputsHash: string;
  frozenAt: string;
  drandChain: string;
  drandRound: number;
  drandRoundAt: string;
  counts: FrozenSummary;
  drawRunId: string;
  /** Set when inputs read back after the commit no longer match (e.g. a late write raced the freeze). The snapshot stays authoritative. */
  driftDetected?: boolean;
}

/** The protocol's one date format: ISO 8601, UTC, milliseconds, "Z" (Appwrite returns "+00:00"; normalise on read). */
const isoUtc = (value: string): string => new Date(value).toISOString();

const resultFrom = (status: FreezeResult['status'], snap: Row<'frozen_inputs'>, extra: Partial<FreezeResult> = {}): FreezeResult => {
  const counts = JSON.parse(snap.override_counts) as Record<string, number>;
  return {
    status,
    programId: snap.program_id,
    format: snap.format,
    algorithm: snap.algorithm,
    inputsHash: snap.inputs_hash,
    frozenAt: isoUtc(snap.frozen_at),
    drandChain: snap.drand_chain,
    drandRound: snap.drand_round,
    drandRoundAt: isoUtc(snap.drand_round_at),
    counts: { applications: snap.applications, children: snap.children, sessions: snap.sessions, seats: snap.seats, overrides: snap.overrides, overrideCounts: counts },
    drawRunId: protocolDrawRunId(snap.program_id),
    ...extra,
  };
};

/** Pseudonymous audit payload for a snapshot; also used to repair a missing entry. */
const frozenPayload = (
  snap: Pick<Row<'frozen_inputs'>, 'format' | 'algorithm' | 'inputs_hash' | 'frozen_at' | 'drand_chain' | 'drand_round' | 'drand_round_at' | 'applications' | 'children' | 'sessions' | 'seats' | 'overrides' | 'override_counts' | 'application_order_hash'>,
) => ({
  format: snap.format,
  algorithm: snap.algorithm,
  inputs_hash: snap.inputs_hash,
  frozen_at: isoUtc(snap.frozen_at),
  drand_chain: snap.drand_chain,
  drand_round: snap.drand_round,
  drand_round_at: isoUtc(snap.drand_round_at),
  applications: snap.applications,
  children: snap.children,
  sessions: snap.sessions,
  seats: snap.seats,
  overrides: snap.overrides,
  override_counts: JSON.parse(snap.override_counts) as Record<string, number>,
  // Task 13: submission order committed with the inputs (not a draw input); absent for older snapshots.
  ...(snap.application_order_hash ? { application_order_hash: snap.application_order_hash } : {}),
});

/** Appends `event` unless the program already has one (repairs a crash between a commit and its audit entry). */
async function ensureAudit(db: ServerDb, programId: string, event: string, payload: () => Record<string, unknown>): Promise<void> {
  if (!(await findAuditEvent(db, programId, event))) await appendAudit(db, { programId, event, payload: payload() });
}

async function alreadyFrozen(db: ServerDb, program: Row<'programs'>): Promise<FreezeResult> {
  const snap = await findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id));
  if (!snap) {
    throw new AppError('conflict', `This program is "${program.status}" but has no published input snapshot, so it cannot be verified. It was not frozen through the freeze protocol.`);
  }
  await ensureAudit(db, program.$id, 'inputs_frozen', () => frozenPayload(snap));
  return resultFrom('already_frozen', snap);
}

/** The eligible inputs as the database holds them now: submitted applications that have at least one child. */
async function eligibleInputs(db: ServerDb, program: Row<'programs'>): Promise<{ inputs: DrawInputs; excluded: number; applicationOrder: string[] }> {
  const { inputs, submittedAt } = await buildDrawInputs(db, program);
  const applications = inputs.applications.filter((a) => a.children.length > 0);
  const applicationOrder = applicationOrderOf(applications.map((a) => ({ publicId: a.publicId, submittedAt: submittedAt?.get(a.publicId) ?? null })));
  return { inputs: { ...inputs, applications }, excluded: inputs.applications.length - applications.length, applicationOrder };
}

/** Checks everything that must hold before freezing an open program. Throws AppError with a user-facing reason. */
export function assertFreezable(program: Row<'programs'>, now: Date): { round: number; roundAt: number } {
  if (program.status === 'draft') throw new AppError('locked', 'Publish the program before freezing it.');
  if (now < new Date(program.window_close)) {
    throw new AppError('locked', `Applications are open until ${isoUtc(program.window_close)}; inputs can only be frozen after they close.`);
  }
  const round = program.drand_round;
  const profile = timingOf(program);
  if (round === null || round === undefined) throw new AppError('locked', 'No drand round was announced for this program, so there is no pre-committed source of randomness. It cannot be frozen.');
  if (program.drand_chain !== DRAND_CHAIN.hash) throw new AppError('locked', 'The announced drand round is on a chain this version cannot verify.');
  if (round !== announcedRound(program.window_close, profile)) throw new AppError('locked', 'The stored drand round does not match the announcement rule for this window; refusing to freeze.');
  if (now.getTime() > freezeDeadlineMs(round, profile)) {
    throw new AppError(
      'locked',
      `Too late to freeze safely: drand round ${String(round)} is due ${new Date(roundTimeMs(round)).toISOString()}, and inputs must be frozen at least ${TIMING[profile].freezeMarginMs >= 60_000 ? `${String(TIMING[profile].freezeMarginMs / 60_000)} minutes` : `${String(TIMING[profile].freezeMarginMs / 1000)} seconds`} before it. A new round cannot be chosen after the fact.`,
    );
  }
  return { round, roundAt: roundTimeMs(round) };
}

/**
 * Validates and freezes a program's draw inputs. Safe to call any number of
 * times, concurrently, by organisers or the scheduled job: exactly one
 * snapshot can commit, and every caller gets that snapshot back.
 */
export async function freezeProgram(db: ServerDb, programId: string, opts: { now?: Date; maxAttempts?: number } = {}): Promise<FreezeResult> {
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? 5;
  for (let attempt = 1; ; attempt++) {
    const program = await db.getRow('programs', programId).catch((err: unknown) => {
      if (err instanceof ServiceError && err.mapped.kind === 'not_found') throw new AppError('not_found', 'Program not found.');
      throw err;
    });
    if (program.status !== 'open' && program.status !== 'draft') return alreadyFrozen(db, program);
    const { round, roundAt } = assertFreezable(program, now);

    const { inputs, excluded, applicationOrder } = await eligibleInputs(db, program);
    let canonical: string;
    try {
      canonical = serializeFrozenInputs(inputs);
    } catch (err) {
      if (err instanceof FrozenInputsError) throw new AppError('validation', `The inputs cannot be frozen: ${err.problems.slice(0, 5).join('; ')}${err.problems.length > 5 ? ` (and ${String(err.problems.length - 5)} more)` : ''}.`);
      throw err;
    }
    const hash = frozenInputsHash(canonical);
    const orderText = serializeApplicationOrder(applicationOrder);
    const summary = summarizeFrozenInputs(inputs);
    const snapshot = {
      program_id: programId,
      format: FROZEN_FORMAT,
      algorithm: DRAW_ALGORITHM,
      inputs_hash: hash,
      canonical,
      frozen_at: now.toISOString(),
      applications: summary.applications,
      children: summary.children,
      sessions: summary.sessions,
      seats: summary.seats,
      overrides: summary.overrides,
      override_counts: JSON.stringify(summary.overrideCounts),
      drand_chain: DRAND_CHAIN.hash,
      drand_round: round,
      drand_round_at: new Date(roundAt).toISOString(),
      application_order: orderText,
      application_order_hash: artifactHash(orderText),
    };

    try {
      await transitionProgram(db, programId, 'frozen', { inputs_hash: hash }, {
        stage: async (transactionId, current) => {
          if (current.status !== 'open') throw new AppError('conflict', 'The program changed while freezing.');
          await db.createRow('frozen_inputs', frozenInputsRowId(programId), snapshot, { transactionId });
          await db.createRow(
            'draw_runs',
            protocolDrawRunId(programId),
            { program_id: programId, status: 'pending', drand_round: round, inputs_hash: hash, cursor: 0, seed_scheme: SEED_SCHEME, drand_chain: DRAND_CHAIN.hash, beacon_attempts: 0 },
            { transactionId },
          );
          const { rowId, entry } = await prepareAudit(db, { programId, event: 'inputs_frozen', payload: { ...frozenPayload(snapshot), excluded_without_children: excluded } });
          await db.createRow('audit_log', rowId, { program_id: programId, ...entry }, { transactionId });
        },
      });
    } catch (err) {
      // Lost a race: another freeze committed (or an audit append took our seq). Re-read and decide.
      const raced = (err instanceof AppError && (err.code === 'conflict' || err.code === 'locked')) || (err instanceof ServiceError && (err.mapped.kind === 'conflict' || err.mapped.kind === 'transaction_conflict'));
      if (!raced) throw err;
      const latest = await db.getRow('programs', programId);
      if (latest.status !== 'open') return alreadyFrozen(db, latest);
      if (attempt >= maxAttempts) throw err;
      await sleepBackoff(attempt, { baseDelayMs: 100 });
      continue;
    }

    const committed = await db.getRow('frozen_inputs', frozenInputsRowId(programId));
    const after = await eligibleInputs(db, program);
    const driftDetected = frozenInputsHash(serializeFrozenInputs(after.inputs)) !== hash;
    if (driftDetected) {
      await appendAudit(db, { programId, event: 'inputs_changed_after_freeze', payload: { inputs_hash: hash, note: 'Rows changed after the freeze committed; the published snapshot is authoritative.' } });
    }
    return resultFrom('frozen', committed, { driftDetected });
  }
}

/** Scheduled freeze: every open program whose window has closed (late-policy programs near their deadline). */
export async function freezeDuePrograms(db: ServerDb, now = new Date()): Promise<Record<string, unknown>> {
  const due = await allRows(db, 'programs', [Query.equal('status', 'open'), Query.lessThanEqual('window_close', now.toISOString())]);
  const out: Record<string, unknown> = {};
  // Demo sandboxes freeze in the same step that fast-forwards their close (functions/shared/sandbox.ts).
  for (const p of due.filter((d) => d.namespace !== 'demo')) {
    if (p.late_policy === 'accept_late' && p.drand_round && now.getTime() < freezeDeadlineMs(p.drand_round) - LATE_AUTO_FREEZE_LEAD_MS) {
      out[p.$id] = { status: 'late_window' };
      continue;
    }
    try {
      const r = await freezeProgram(db, p.$id, { now });
      out[p.$id] = { status: r.status, inputsHash: r.inputsHash };
    } catch (err) {
      out[p.$id] = { status: 'not_frozen', reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

/**
 * Backfill for programs published before rounds were announced: commits to
 * the round the announcement rule gives, only while that round is still far
 * in the future and the program is still open. Never changes a set round.
 */
export async function announceMissingRounds(db: ServerDb, now = new Date()): Promise<Record<string, number>> {
  const open = await allRows(db, 'programs', [Query.equal('status', 'open'), Query.isNull('drand_round')]);
  const out: Record<string, number> = {};
  // Demo sandboxes announce their demo-timed round when their close is fast-forwarded, never here.
  for (const p of open.filter((o) => o.namespace !== 'demo')) {
    const round = announcedRound(p.window_close);
    if (now.getTime() > freezeDeadlineMs(round)) continue;
    await db.updateRow('programs', p.$id, { drand_round: round, drand_chain: DRAND_CHAIN.hash });
    await ensureAudit(db, p.$id, 'drand_round_announced', () => ({ drand_chain: DRAND_CHAIN.hash, drand_round: round, drand_round_at: new Date(roundTimeMs(round)).toISOString(), rule: 'first round at or after window_close + 3 h' }));
    out[p.$id] = round;
  }
  return out;
}

// ---- Draw context from the snapshot --------------------------------------------------

/**
 * The draw context from the PUBLISHED snapshot (not from live rows), after
 * re-checking that the stored text is canonical and hashes to the published
 * hash. Private mappings (ticket ref -> child, public ID -> family) come from
 * the database and stay on the server. Null if the program has no snapshot.
 */
export async function loadFrozenContext(db: ServerDb, program: Row<'programs'>): Promise<DrawContext | null> {
  const snap = await findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id));
  if (!snap) return null;
  const { inputs, hash } = parseFrozenInputs(snap.canonical);
  if (hash !== snap.inputs_hash || hash !== program.inputs_hash) throw new Error('The stored snapshot does not hash to the published inputs hash.');
  const [tickets, apps] = await Promise.all([
    allRows(db, 'tickets', [Query.equal('program_id', program.$id)]),
    allRows(db, 'applications', [Query.equal('program_id', program.$id)]),
  ]);
  const ticketById = new Map(tickets.map((t) => [t.$id, t]));
  const familyByPublic = new Map(apps.map((a) => [a.public_id, a.family_id]));
  const children = new Map<string, { childId: string; familyId: string }>();
  const families = new Map<string, string>();
  for (const a of inputs.applications) {
    const familyId = familyByPublic.get(a.publicId);
    if (!familyId) throw new Error(`Snapshot application ${a.publicId} has no matching application row.`);
    families.set(a.publicId, familyId);
    for (const c of a.children) {
      const t = ticketById.get(c.ref);
      if (!t || t.family_id !== familyId) throw new Error(`Snapshot child ${c.ref} has no matching ticket in that household.`);
      children.set(c.ref, { childId: t.child_id, familyId });
    }
  }
  return { inputs, children, families };
}

// ---- Beacon ---------------------------------------------------------------------------

export type BeaconOutcome =
  | { status: 'verified' | 'already_verified'; drawRunId: string; round: number; seed: string }
  | { status: 'waiting'; drawRunId: string; round: number; roundAt: string; detail: string }
  | { status: 'unavailable' | 'rejected'; drawRunId: string; round: number; detail: string }
  | { status: 'not_protocol'; drawRunId: string; detail: string };

export interface BeaconOptions {
  now?: Date;
  /** Injected in tests; defaults to the official drand HTTP relays. */
  fetchBeacon?: (round: number) => Promise<BeaconFetch>;
}

const beaconPayload = (run: Row<'draw_runs'>) => ({
  draw_run_id: run.$id,
  drand_chain: run.drand_chain,
  drand_round: run.drand_round,
  randomness: run.beacon_randomness,
  signature: run.beacon_signature,
  verifier: run.beacon_verifier,
  seed_scheme: run.seed_scheme,
  inputs_hash: run.inputs_hash,
  seed: run.seed,
});

/**
 * Checks that a protocol draw run's seed came from a verified beacon for the
 * announced round: re-verifies the stored signature offline and re-derives
 * the seed. Returns a reason when it does not.
 */
export async function seedProvenanceProblem(run: Row<'draw_runs'>, program: Row<'programs'>): Promise<string | null> {
  if (!run.seed) return 'No seed yet.';
  if (run.seed_scheme !== SEED_SCHEME || run.beacon_verified !== true) return 'The seed was not derived from a verified beacon.';
  if (run.drand_round !== program.drand_round || run.drand_chain !== DRAND_CHAIN.hash || program.drand_chain !== DRAND_CHAIN.hash) return 'The run does not use the announced drand round.';
  if (run.inputs_hash !== program.inputs_hash) return 'The run does not use the frozen inputs hash.';
  const check = await verifyBeacon({ round: run.drand_round, randomness: run.beacon_randomness, signature: run.beacon_signature }, run.drand_round);
  if (!check.ok) return `Stored beacon no longer verifies: ${check.reason}`;
  const expected = deriveSeed({ chainHash: DRAND_CHAIN.hash, round: run.drand_round, randomness: check.beacon.randomness, inputsHash: run.inputs_hash, programId: program.$id });
  return expected === run.seed ? null : 'The stored seed does not match the seed derived from the beacon.';
}

/**
 * Fetches and verifies the beacon for a pending protocol draw run and stores
 * the derived seed. Never selects another round, never substitutes another
 * source: on any failure the run simply stays pending for the next attempt.
 */
export async function resolveBeacon(db: ServerDb, drawRunId: string, opts: BeaconOptions = {}): Promise<BeaconOutcome> {
  const now = opts.now ?? new Date();
  const run = await db.getRow('draw_runs', drawRunId);
  if (run.seed_scheme !== SEED_SCHEME) return { status: 'not_protocol', drawRunId, detail: 'This run was not created by the freeze protocol.' };
  if (run.seed) return { status: 'already_verified', drawRunId, round: run.drand_round, seed: run.seed };

  const program = await db.getRow('programs', run.program_id);
  const round = run.drand_round;
  const record = async (status: 'unavailable' | 'rejected', detail: string): Promise<BeaconOutcome> => {
    await db.updateRow('draw_runs', drawRunId, { beacon_attempts: (run.beacon_attempts ?? 0) + 1, beacon_last_error: `${status}: ${detail}`.slice(0, 256) });
    return { status, drawRunId, round, detail };
  };
  if (program.status !== 'frozen') return record('rejected', `Program is "${program.status}", not frozen.`);
  if (round !== program.drand_round || run.drand_chain !== DRAND_CHAIN.hash || run.inputs_hash !== program.inputs_hash || drawRunId !== protocolDrawRunId(program.$id)) {
    return record('rejected', 'The run does not match the program\'s announced round, chain or frozen inputs.');
  }
  const roundAt = roundTimeMs(round);
  if (now.getTime() < roundAt) return { status: 'waiting', drawRunId, round, roundAt: new Date(roundAt).toISOString(), detail: 'The announced round has not been produced yet.' };

  const fetched = await (opts.fetchBeacon ?? ((r: number) => fetchBeaconFromRelays(r)))(round);
  if (fetched.status === 'not_yet') return { status: 'waiting', drawRunId, round, roundAt: new Date(roundAt).toISOString(), detail: fetched.detail };
  if (fetched.status === 'unavailable') return record('unavailable', fetched.detail);
  const check = await verifyBeacon(fetched.beacon, round);
  if (!check.ok) return record('rejected', `${fetched.relay}: ${check.reason}`);

  const seed = deriveSeed({ chainHash: DRAND_CHAIN.hash, round, randomness: check.beacon.randomness, inputsHash: run.inputs_hash, programId: program.$id });
  const update = {
    seed,
    beacon_randomness: check.beacon.randomness,
    beacon_signature: check.beacon.signature,
    beacon_verified: true,
    beacon_verified_at: now.toISOString(),
    beacon_verifier: DRAND_VERIFIER,
    beacon_attempts: (run.beacon_attempts ?? 0) + 1,
    beacon_last_error: null,
  };
  // Seed, audit entry and a deterministic idempotency row commit together: a second resolver,
  // concurrent or not, cannot commit (its idempotency row collides) and returns the stored seed.
  for (let attempt = 1; ; attempt++) {
    const latest = await db.getRow('draw_runs', drawRunId);
    if (latest.seed) return { status: 'already_verified', drawRunId, round, seed: latest.seed };
    const tx = await db.transactions.begin(60);
    try {
      await db.createRow('idempotency', idempotencyRowId('beacon', drawRunId), { scope: 'beacon', program_id: program.$id, key_hash: sha256Hex(drawRunId), result: JSON.stringify({ seed }) }, { transactionId: tx.$id });
      await db.updateRow('draw_runs', drawRunId, update, { transactionId: tx.$id });
      const { rowId, entry } = await prepareAudit(db, { programId: program.$id, event: 'beacon_verified', payload: { ...beaconPayload({ ...run, ...update }), relay: fetched.relay } });
      await db.createRow('audit_log', rowId, { program_id: program.$id, ...entry }, { transactionId: tx.$id });
      await db.transactions.commit(tx.$id);
      return { status: 'verified', drawRunId, round, seed };
    } catch (err) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      const after = await db.getRow('draw_runs', drawRunId);
      if (after.seed) return { status: 'already_verified', drawRunId, round, seed: after.seed };
      if (!(err instanceof ServiceError && (err.mapped.kind === 'conflict' || err.mapped.kind === 'transaction_conflict')) || attempt >= 5) throw err;
      await sleepBackoff(attempt, { baseDelayMs: 100 });
    }
  }
}

/** Every pending protocol run without a seed. */
export async function resolvePendingBeacons(db: ServerDb, opts: BeaconOptions = {}): Promise<Record<string, unknown>> {
  const runs = await allRows(db, 'draw_runs', [Query.equal('status', 'pending'), Query.isNull('seed'), Query.equal('seed_scheme', SEED_SCHEME)]);
  const out: Record<string, unknown> = {};
  for (const r of runs) {
    try {
      out[r.$id] = await resolveBeacon(db, r.$id, opts);
    } catch (err) {
      out[r.$id] = { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

/** Audit entry once a draw run has finished (idempotent). */
export async function recordDrawOutcome(db: ServerDb, run: Row<'draw_runs'>, extra: Record<string, unknown> = {}): Promise<void> {
  if (run.status === 'completed') {
    await ensureAudit(db, run.program_id, 'draw_completed', () => ({ draw_run_id: run.$id, inputs_hash: run.inputs_hash, seed: run.seed, plan_hash: run.plan_hash, steps: run.cursor, ...extra }));
  } else if (run.status === 'failed') {
    await ensureAudit(db, run.program_id, 'draw_failed', () => ({ draw_run_id: run.$id, inputs_hash: run.inputs_hash, at_step: run.cursor, reason: run.error }));
  }
}
