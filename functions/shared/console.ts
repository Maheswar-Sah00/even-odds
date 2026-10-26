import { Permission, Query, Role, type Users } from 'node-appwrite';
import type { ConsoleCommand } from '../../shared/console-input.ts';
import { fairnessReport, familiesFromInputs, type FairnessPlacement } from '../../shared/fairness.ts';
import { parseApplicationOrder } from '../../shared/replay/result.ts';
import { parseFrozenInputs } from '../../shared/freeze/canonical.ts';
import { freezeDeadlineMs, roundTimeMs, timingOf } from '../../shared/freeze/protocol.ts';
import { AppError } from './app-error.ts';
import { appendAudit, prepareAudit } from './audit.ts';
import { canonicalJson, deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { frozenInputsRowId, protocolDrawRunId } from './freeze.ts';
import { allRows, findRow, isKind, ticketRowId } from './household.ts';
import type { Scope } from './namespace.ts';
import { cancelOffers, organiserOffersOverview, processOffers } from './offer-actions.ts';
import { serverNow } from './offers.ts';
import { checkCapacityChange } from './organiser.ts';
import { sleepBackoff } from './retry.ts';

/**
 * Organiser control centre (Task 12). One implementation for production
 * programs and demo sandboxes; the api handlers decide who may call it
 * (functions/api/src/handlers/console.ts and demo.ts).
 *
 * Every privileged change goes through privileged(): the change, a
 * staff_actions row naming the actor (organiser team only) and a public,
 * pseudonymous audit_log entry are staged in ONE transaction, so a change
 * without its log cannot commit. The staff row has a deterministic ID per
 * idempotency key, so a retried request replays instead of repeating.
 *
 * Pre-freeze inputs (tier verification, overrides) can change only while the
 * program is open. The freeze snapshot is authoritative: a change that
 * commits in the instant after a concurrent freeze is detected afterwards,
 * flagged, and is not part of the draw.
 */

export interface ConsoleActor {
  program: Row<'programs'>;
  actorId: string;
  /** The program's organiser Team (production) or sandbox Team (demo). */
  teamId: string;
  scope: Scope;
  users: Users;
}

/** Pseudonymous, stable reference to a staff member in the public log (no user ID). */
export const staffRef = (teamId: string, actorId: string) => sha256Hex(`staff\n${teamId}\n${actorId}`).slice(0, 16);
export const overrideRowId = (programId: string, familyId: string) => deterministicId('ov', 'override', programId, familyId);
const staffRowId = (programId: string, action: string, key: string) => deterministicId('sa', 'staff', programId, action, key);

const teamRead = (teamId: string) => [Permission.read(Role.team(teamId))];
const tierLabels = (p: Row<'programs'>) => JSON.parse(p.tier_labels ?? '{}') as Record<string, string>;

export interface PrivilegedChange {
  action: string;
  target?: string;
  reasonCode?: string;
  detail: Record<string, unknown>;
  /** Public audit event; its payload is `detail` plus reason and staff_ref (pseudonymous only). */
  event: string;
  idempotencyKey: string;
  /** The caller's request fields (not derived state): binds the idempotency key to this request. */
  request?: Record<string, unknown>;
  /**
   * What the PUBLIC audit entry carries, when it must be less than `detail` (Task 14): reasons
   * such as an accommodation need or an address outside the zone stay in the staff log only.
   */
  publicDetail?: Record<string, unknown>;
  /** Keep reasonCode out of the public audit entry (it is still in the staff log). */
  privateReason?: boolean;
}

export type PrivilegedResult = { status: 'changed' | 'replayed'; auditSeq: number | null };

/**
 * Stages `stage` + the staff log row + the public audit entry in one
 * transaction. Retries audit-sequence races; a repeated idempotency key
 * returns "replayed" without doing anything.
 */
export async function privileged(db: ServerDb, actor: ConsoleActor, change: PrivilegedChange, stage: (transactionId: string) => Promise<void>): Promise<PrivilegedResult> {
  const programId = actor.program.$id;
  // A key replays only the request it was first used with (Task 14): the request's hash is part
  // of the row ID, so a reused key carrying a different request is a new change, never a silent skip.
  const requestPart = change.request ? `:${sha256Hex(canonicalJson(change.request)).slice(0, 16)}` : '';
  const rowId = staffRowId(programId, change.action, `${actor.actorId}:${change.idempotencyKey}${requestPart}`);
  const replay = async (): Promise<PrivilegedResult | null> => {
    const row = await findRow(db, 'staff_actions', rowId);
    return row ? { status: 'replayed', auditSeq: row.audit_seq ?? null } : null;
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const payload = {
    ...(change.publicDetail ?? change.detail),
    ...(change.target ? { target: change.target } : {}),
    ...(change.reasonCode && !change.privateReason ? { reason_code: change.reasonCode } : {}),
    staff_ref: staffRef(actor.teamId, actor.actorId),
  };
  for (let attempt = 1; ; attempt++) {
    const { rowId: auditRowId, entry } = await prepareAudit(db, { programId, event: change.event, payload });
    const tx = await db.transactions.begin(60);
    try {
      await stage(tx.$id);
      await db.createRow(
        'staff_actions',
        rowId,
        {
          program_id: programId,
          actor_id: actor.actorId,
          action: change.action,
          ...(change.target ? { target: change.target } : {}),
          ...(change.reasonCode ? { reason_code: change.reasonCode } : {}),
          detail: canonicalJson(change.detail),
          audit_seq: entry.seq,
        },
        { permissions: teamRead(actor.teamId), transactionId: tx.$id },
      );
      await db.createRow('audit_log', auditRowId, { program_id: programId, ...entry }, { transactionId: tx.$id });
    } catch (err) {
      await db.transactions.rollback(tx.$id).catch(() => undefined);
      throw err;
    }
    try {
      await db.transactions.commit(tx.$id);
      return { status: 'changed', auditSeq: entry.seq };
    } catch (err) {
      if (!isKind(err, 'transaction_conflict', 'conflict')) throw err;
      const replayed = await replay();
      if (replayed) return replayed;
      if (attempt >= 5) throw new AppError('conflict', 'Someone else changed this at the same time. Reload and try again.');
      await sleepBackoff(attempt, { baseDelayMs: 80 });
    }
  }
}

/** A privileged change that happens elsewhere (freeze, offer cancellation): log it after the fact. */
export async function logStaffAction(db: ServerDb, actor: ConsoleActor, entry: { action: string; target?: string; reasonCode?: string; detail: Record<string, unknown>; auditSeq?: number | null; key: string }) {
  await db
    .createRow(
      'staff_actions',
      staffRowId(actor.program.$id, entry.action, `${actor.actorId}:${entry.key}`),
      {
        program_id: actor.program.$id,
        actor_id: actor.actorId,
        action: entry.action,
        ...(entry.target ? { target: entry.target } : {}),
        ...(entry.reasonCode ? { reason_code: entry.reasonCode } : {}),
        detail: canonicalJson(entry.detail),
        ...(entry.auditSeq ? { audit_seq: entry.auditSeq } : {}),
      },
      { permissions: teamRead(actor.teamId) },
    )
    .catch((err: unknown) => {
      if (!isKind(err, 'conflict')) throw err; // already logged (a retried request)
    });
}

function requireOpenInputs(program: Row<'programs'>, what: string) {
  if (program.status !== 'open') throw new AppError('locked', `${what} can only change while applications are open. The inputs are ${program.status === 'draft' ? 'not published yet' : 'frozen'}.`);
}

async function applicationByPublicId(db: ServerDb, programId: string, publicId: string): Promise<Row<'applications'>> {
  const { rows } = await db.listRows('applications', [Query.equal('program_id', programId), Query.equal('public_id', publicId), Query.limit(1)]);
  const app = rows[0];
  if (!app) throw new AppError('not_found', 'No application has that receipt code.');
  return app;
}

/** After a pre-freeze change committed: if a freeze won the race, the snapshot (authoritative) decides. */
async function frozenMeanwhile(db: ServerDb, programId: string) {
  const program = await db.getRow('programs', programId);
  if (program.status === 'open') return null;
  const snap = await findRow(db, 'frozen_inputs', frozenInputsRowId(programId));
  return snap ? parseFrozenInputs(snap.canonical).inputs : null;
}

async function actorLabels(users: Users, ids: readonly string[], me: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      if (id === me) {
        out.set(id, 'You');
        return;
      }
      const u = await users.get({ userId: id }).catch(() => null);
      out.set(id, u?.email || u?.name || `Staff ${id.slice(0, 6)}`);
    }),
  );
  return out;
}

// ---- demand ------------------------------------------------------------------------

export async function demandReport(db: ServerDb, program: Row<'programs'>) {
  const scope = [Query.equal('program_id', program.$id)];
  const [apps, prefs, ledgers] = await Promise.all([allRows(db, 'applications', [...scope, Query.equal('status', 'submitted')]), allRows(db, 'preferences', scope), allRows(db, 'seat_ledger', scope)]);
  const submitted = new Set(apps.map((a) => a.family_id));
  const live = prefs.filter((p) => submitted.has(p.family_id));
  const k = (w: string, g: string) => `${w}\u0000${g}`;
  const first = new Map<string, number>();
  const any = new Map<string, number>();
  for (const p of live) {
    p.ranked_weeks.forEach((w, i) => {
      const key = k(w, p.ranked_age_groups?.[i] ?? '');
      any.set(key, (any.get(key) ?? 0) + 1);
      if (i === 0) first.set(key, (first.get(key) ?? 0) + 1);
    });
  }
  const sessions = ledgers
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || a.min_age - b.min_age)
    .map((l) => {
      const ranked = any.get(k(l.week, l.age_group)) ?? 0;
      const firstChoice = first.get(k(l.week, l.age_group)) ?? 0;
      return { ledgerId: l.$id, week: l.week, weekLabel: l.label ?? l.week, ageGroup: l.age_group, capacity: l.capacity, taken: l.taken, firstChoice, ranked, perSeat: l.capacity ? ranked / l.capacity : null, oversubscribed: ranked > l.capacity };
    });
  return {
    applications: apps.length,
    late: apps.filter((a) => a.late).length,
    children: live.length,
    weeksRequested: live.reduce((n, p) => n + p.requested_weeks, 0),
    seats: ledgers.reduce((n, l) => n + l.capacity, 0),
    oversubscribed: sessions.filter((s) => s.oversubscribed).length,
    sessions,
  };
}

// ---- verification queue -------------------------------------------------------------

export async function verificationQueue(db: ServerDb, program: Row<'programs'>) {
  const scope = [Query.equal('program_id', program.$id)];
  const [apps, prefs] = await Promise.all([allRows(db, 'applications', [...scope, Query.equal('status', 'submitted')]), allRows(db, 'preferences', scope)]);
  const children = new Map<string, number>();
  for (const p of prefs) children.set(p.family_id, (children.get(p.family_id) ?? 0) + 1);
  const defaultTier = program.default_tier ?? 9;
  const items = apps.map((a) => {
    const claimed = a.claimed_tier ?? defaultTier;
    const verified = a.verified_tier ?? null;
    return {
      publicId: a.public_id,
      claimedTier: claimed,
      verifiedTier: verified,
      effectiveTier: verified ?? claimed,
      priorityClaim: claimed < defaultTier,
      nearBoundary: a.near_boundary ?? false,
      children: children.get(a.family_id) ?? 0,
      late: a.late ?? false,
      state: verified === null ? ('unverified' as const) : verified === claimed ? ('confirmed' as const) : ('changed' as const),
    };
  });
  // Priority claims and near-boundary homes need review; unverified ones first.
  const weight = (i: (typeof items)[number]) => (i.state === 'unverified' ? 0 : 2) + (i.priorityClaim || i.nearBoundary ? 0 : 1);
  items.sort((a, b) => weight(a) - weight(b) || Number(b.nearBoundary) - Number(a.nearBoundary) || a.claimedTier - b.claimedTier || a.publicId.localeCompare(b.publicId));
  return {
    locked: program.status !== 'open',
    tierLabels: tierLabels(program),
    defaultTier,
    needsReview: items.filter((i) => i.state === 'unverified' && (i.priorityClaim || i.nearBoundary)).length,
    items,
  };
}

export async function verifyTier(db: ServerDb, actor: ConsoleActor, cmd: Extract<ConsoleCommand, { action: 'verifyTier' }>) {
  const { program } = actor;
  requireOpenInputs(program, 'Tiers');
  if (!(String(cmd.tier) in tierLabels(program))) throw new AppError('validation', `Tier ${String(cmd.tier)} is not one of this program's tiers.`, 'tier');
  const app = await applicationByPublicId(db, program.$id, cmd.publicId);
  if (app.status !== 'submitted') throw new AppError('locked', 'Only submitted applications can be verified.');
  const claimed = app.claimed_tier ?? program.default_tier ?? 9;
  if (cmd.reasonCode === 'residency_confirmed' && cmd.tier !== claimed) throw new AppError('validation', '"Residency confirmed" keeps the claimed tier. Choose another reason to change it.', 'reasonCode');
  const result = await privileged(
    db,
    actor,
    { action: 'tier_verified', event: 'tier_verified', target: app.public_id, reasonCode: cmd.reasonCode, idempotencyKey: cmd.idempotencyKey, request: { publicId: cmd.publicId, tier: cmd.tier, reasonCode: cmd.reasonCode }, privateReason: true, detail: { public_id: app.public_id, claimed_tier: claimed, before: app.verified_tier ?? null, verified_tier: cmd.tier } },
    (transactionId) => db.updateRow('applications', app.$id, { verified_tier: cmd.tier }, { transactionId }).then(() => undefined),
  );
  const frozen = result.status === 'changed' ? await frozenMeanwhile(db, program.$id) : null;
  const inSnapshot = frozen ? frozen.applications.find((a) => a.publicId === app.public_id)?.tier === cmd.tier : true;
  if (!inSnapshot) await appendAudit(db, { programId: program.$id, event: 'change_after_freeze', payload: { action: 'tier_verified', target: app.public_id, note: 'Committed after the freeze; the published snapshot is authoritative.' } });
  return { ...result, publicId: app.public_id, verifiedTier: cmd.tier, inSnapshot };
}

// ---- overrides ----------------------------------------------------------------------

export async function listOverrides(db: ServerDb, actor: ConsoleActor) {
  const { program } = actor;
  const scope = [Query.equal('program_id', program.$id)];
  const [rows, apps] = await Promise.all([allRows(db, 'overrides', scope), allRows(db, 'applications', scope)]);
  const publicOf = new Map(apps.map((a) => [a.family_id, a.public_id]));
  const labels = await actorLabels(actor.users, rows.map((r) => r.created_by), actor.actorId);
  const snapshot = await findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id));
  const frozen = snapshot ? new Set(parseFrozenInputs(snapshot.canonical).inputs.overrides.map((o) => o.publicId)) : null;
  return {
    locked: program.status !== 'open',
    overrides: rows
      .sort((a, b) => a.$createdAt.localeCompare(b.$createdAt))
      .map((r) => ({
        publicId: publicOf.get(r.family_id) ?? '',
        reasonCode: r.reason_code,
        pool: r.pool,
        createdBeforeFreeze: r.created_before_freeze,
        createdAt: new Date(r.$createdAt).toISOString(),
        actor: labels.get(r.created_by) ?? r.created_by,
        inSnapshot: frozen ? frozen.has(publicOf.get(r.family_id) ?? '') : null,
      })),
  };
}

export async function createOverride(db: ServerDb, actor: ConsoleActor, cmd: Extract<ConsoleCommand, { action: 'createOverride' }>) {
  const { program } = actor;
  requireOpenInputs(program, 'Overrides');
  const app = await applicationByPublicId(db, program.$id, cmd.publicId);
  if (app.status !== 'submitted') throw new AppError('locked', 'Only submitted applications can get an override.');
  const rowId = overrideRowId(program.$id, app.family_id);
  if (await findRow(db, 'overrides', rowId)) {
    const replay = await findRow(db, 'staff_actions', staffRowId(program.$id, 'override_created', `${actor.actorId}:${cmd.idempotencyKey}`));
    if (!replay) throw new AppError('conflict', 'This family already has an override. Remove it first to change the reason.');
  }
  let result: PrivilegedResult;
  try {
    result = await privileged(
      db,
      actor,
      { action: 'override_created', event: 'override_created', target: app.public_id, reasonCode: cmd.reasonCode, idempotencyKey: cmd.idempotencyKey, request: { publicId: cmd.publicId, reasonCode: cmd.reasonCode, pool: cmd.pool }, privateReason: true, publicDetail: { public_id: app.public_id, created_before_freeze: true }, detail: { public_id: app.public_id, pool: cmd.pool, created_before_freeze: true } },
      (transactionId) =>
        db
          .createRow('overrides', rowId, { program_id: program.$id, family_id: app.family_id, reason_code: cmd.reasonCode, pool: cmd.pool, created_before_freeze: true, created_by: actor.actorId }, { permissions: teamRead(actor.teamId), transactionId })
          .then(() => undefined),
    );
  } catch (err) {
    if (err instanceof AppError && err.code === 'conflict' && (await findRow(db, 'overrides', rowId))) throw new AppError('conflict', 'This family already has an override. Remove it first to change the reason.');
    throw err;
  }
  // created_before_freeze must be true only if the snapshot really contains it.
  const frozen = result.status === 'changed' ? await frozenMeanwhile(db, program.$id) : null;
  const inSnapshot = frozen ? frozen.overrides.some((o) => o.publicId === app.public_id) : true;
  if (!inSnapshot) {
    await db.updateRow('overrides', rowId, { created_before_freeze: false });
    await appendAudit(db, { programId: program.$id, event: 'change_after_freeze', payload: { action: 'override_created', target: app.public_id, note: 'Committed after the freeze; not in the published snapshot, so it does not affect the draw.' } });
  }
  return { ...result, publicId: app.public_id, inSnapshot };
}

export async function removeOverride(db: ServerDb, actor: ConsoleActor, cmd: Extract<ConsoleCommand, { action: 'removeOverride' }>) {
  const { program } = actor;
  requireOpenInputs(program, 'Overrides');
  const app = await applicationByPublicId(db, program.$id, cmd.publicId);
  const rowId = overrideRowId(program.$id, app.family_id);
  const existing = await findRow(db, 'overrides', rowId);
  if (!existing) {
    const replay = await findRow(db, 'staff_actions', staffRowId(program.$id, 'override_removed', `${actor.actorId}:${cmd.idempotencyKey}`));
    if (replay) return { status: 'replayed' as const, auditSeq: replay.audit_seq ?? null, publicId: app.public_id };
    throw new AppError('not_found', 'This family has no override.');
  }
  const result = await privileged(
    db,
    actor,
    { action: 'override_removed', event: 'override_removed', target: app.public_id, reasonCode: existing.reason_code, idempotencyKey: cmd.idempotencyKey, request: { publicId: cmd.publicId }, privateReason: true, publicDetail: { public_id: app.public_id }, detail: { public_id: app.public_id, pool: existing.pool } },
    (transactionId) => db.deleteRow('overrides', rowId, transactionId).then(() => undefined),
  );
  return { ...result, publicId: app.public_id };
}

// ---- logs, draw status, fairness ---------------------------------------------------

export async function staffLog(db: ServerDb, actor: ConsoleActor) {
  const { rows } = await db.listRows('staff_actions', [Query.equal('program_id', actor.program.$id), Query.orderDesc('$createdAt'), Query.limit(200)]);
  const labels = await actorLabels(actor.users, rows.map((r) => r.actor_id), actor.actorId);
  return {
    entries: rows.map((r) => ({
      id: r.$id,
      at: new Date(r.$createdAt).toISOString(),
      actor: labels.get(r.actor_id) ?? r.actor_id,
      action: r.action,
      target: r.target ?? null,
      reasonCode: r.reason_code ?? null,
      detail: JSON.parse(r.detail ?? '{}') as Record<string, unknown>,
      auditSeq: r.audit_seq ?? null,
    })),
  };
}

export async function drawStatus(db: ServerDb, program: Row<'programs'>) {
  const [run, snapshot, now] = await Promise.all([findRow(db, 'draw_runs', protocolDrawRunId(program.$id)), findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id)), serverNow(db)]);
  const round = program.drand_round ?? null;
  const profile = timingOf(program);
  return {
    serverTime: now.toISOString(),
    status: program.status,
    timing: profile,
    windowClose: new Date(program.window_close).toISOString(),
    drandRound: round,
    roundAt: round ? new Date(roundTimeMs(round)).toISOString() : null,
    freezeDeadline: round ? new Date(freezeDeadlineMs(round, profile)).toISOString() : null,
    inputsHash: program.inputs_hash ?? null,
    snapshot: snapshot ? { frozenAt: new Date(snapshot.frozen_at).toISOString(), applications: snapshot.applications, children: snapshot.children, seats: snapshot.seats, overrides: snapshot.overrides } : null,
    run: run
      ? {
          id: run.$id,
          status: run.status,
          cursor: run.cursor,
          seed: run.seed ?? null,
          beaconVerified: run.beacon_verified ?? false,
          beaconAttempts: run.beacon_attempts ?? 0,
          beaconLastError: run.beacon_last_error ?? null,
          planHash: run.plan_hash ?? null,
          error: run.error ?? null,
          finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
        }
      : null,
    offersIssuedAt: program.offers_issued_at ? new Date(program.offers_issued_at).toISOString() : null,
  };
}

/** Fairness report card from the frozen snapshot (authoritative inputs) and the draw's committed placements. */
export async function fairness(db: ServerDb, program: Row<'programs'>) {
  if (program.status !== 'drawn' && program.status !== 'closed') return { ready: false as const };
  const snap = await findRow(db, 'frozen_inputs', frozenInputsRowId(program.$id));
  if (!snap) return { ready: false as const };
  const { inputs } = parseFrozenInputs(snap.canonical);
  const scope = [Query.equal('program_id', program.$id)];
  const [apps, placements, ledgers] = await Promise.all([allRows(db, 'applications', scope), allRows(db, 'placements', [...scope, Query.isNotNull('draw_run_id')]), allRows(db, 'seat_ledger', scope)]);
  const submittedAt = new Map(apps.map((a) => [a.public_id, a.submitted_at ?? null]));
  const publicOf = new Map(apps.map((a) => [a.family_id, a.public_id]));
  const families = familiesFromInputs(inputs).map((f) => ({ ...f, submittedAt: submittedAt.get(f.publicId) ?? null }));
  // The order committed at freeze, when there is one, so the console and the public page agree.
  const applicationOrder = snap.application_order ? parseApplicationOrder(snap.application_order).order : undefined;
  const drawn: FairnessPlacement[] = placements.map((p) => ({ publicId: publicOf.get(p.family_id) ?? '', childRef: ticketRowId(p.program_id, p.child_id), week: p.week, ageGroup: p.age_group }));
  const report = fairnessReport({
    families,
    placements: drawn,
    sessions: ledgers.map((l) => ({ week: l.week, ageGroup: l.age_group, capacity: l.capacity, taken: l.taken })),
    maxWeeks: inputs.maxWeeks,
    testSeed: snap.inputs_hash,
    ...(applicationOrder ? { applicationOrder } : {}),
  });
  return { ready: true as const, inputsHash: snap.inputs_hash, report };
}

// ---- capacity and offers (privileged, logged) --------------------------------------------

export async function setCapacityLogged(db: ServerDb, actor: ConsoleActor, cmd: { ledgerId: string; capacity: number; idempotencyKey?: string }) {
  const ledger = await findRow(db, 'seat_ledger', cmd.ledgerId);
  if (!ledger || ledger.program_id !== actor.program.$id) throw new AppError('not_found', 'Session not found.');
  checkCapacityChange(actor.program, ledger, cmd.capacity);
  if (ledger.capacity === cmd.capacity) return { status: 'unchanged' as const, capacity: ledger.capacity };
  const result = await privileged(
    db,
    actor,
    {
      action: 'capacity_changed',
      event: 'capacity_changed',
      target: `${ledger.week}/${ledger.age_group}`,
      // Without a client key, the ledger's version makes A->B->A->B a new change each time (Task 14).
      idempotencyKey: cmd.idempotencyKey ?? `${ledger.$id}:${ledger.$updatedAt}:${String(ledger.capacity)}->${String(cmd.capacity)}`,
      request: { ledgerId: ledger.$id, capacity: cmd.capacity },
      detail: { week: ledger.week, age_group: ledger.age_group, before: ledger.capacity, after: cmd.capacity },
    },
    (transactionId) => db.updateRow('seat_ledger', ledger.$id, { capacity: cmd.capacity }, { transactionId }).then(() => undefined),
  );
  return { ...result, capacity: cmd.capacity };
}

export async function cancelOffersLogged(db: ServerDb, actor: ConsoleActor, placementIds: string[], idempotencyKey: string) {
  const result = await cancelOffers(db, actor.program, actor.actorId, placementIds, idempotencyKey);
  if (result.status === 'changed') {
    const refs = await Promise.all(placementIds.map(async (id) => findRow(db, 'placements', id)));
    await logStaffAction(db, actor, { action: 'offers_cancelled', key: idempotencyKey, detail: { refs: refs.flatMap((p) => (p ? [ticketRowId(p.program_id, p.child_id)] : [])), promoted: result.promoted } });
  }
  return result;
}

/** Runs one console command for an already-authorised actor. */
export async function runConsoleCommand(db: ServerDb, actor: ConsoleActor, cmd: ConsoleCommand): Promise<unknown> {
  const { program } = actor;
  switch (cmd.action) {
    case 'demand':
      return demandReport(db, program);
    case 'verificationQueue':
      return verificationQueue(db, program);
    case 'verifyTier':
      return verifyTier(db, actor, cmd);
    case 'overrides':
      return listOverrides(db, actor);
    case 'createOverride':
      return createOverride(db, actor, cmd);
    case 'removeOverride':
      return removeOverride(db, actor, cmd);
    case 'staffLog':
      return staffLog(db, actor);
    case 'fairness':
      return fairness(db, program);
    case 'drawStatus':
      return drawStatus(db, program);
    case 'setCapacity':
      return setCapacityLogged(db, actor, cmd);
    case 'offersOverview':
      if (program.status !== 'drawn' && program.status !== 'closed') throw new AppError('locked', 'Offers exist only after the draw.');
      return organiserOffersOverview(db, program);
    case 'cancelOffers':
      return cancelOffersLogged(db, actor, cmd.placementIds, cmd.idempotencyKey);
    case 'processOffers':
      return processOffers(db, program.$id);
  }
}
