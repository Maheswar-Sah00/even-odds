import { Query } from 'node-appwrite';
import type { OfferResponse } from '../../shared/offer-input.ts';
import { displayOfferStatus, releasesSeat, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import { AppError } from './app-error.ts';
import { canonicalJson, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { allRows, findRow, requireHousehold, ticketRowId } from './household.ts';
import { afterRelease, refreshOfferStats, runOfferSweep, serverNow, toChange, transitionOffers } from './offers.ts';

/**
 * Request-level offer actions for the api Function: who may do what, and the
 * views each audience gets. Families see their own offers and waitlist
 * places; organisers see pseudonymous public IDs and ticket refs (never
 * names); the public sees only offer_stats counts.
 */

export interface OfferView {
  placementId: string;
  week: string;
  weekLabel: string;
  ageGroup: string;
  status: OfferStatus;
  /** "lapsed": still pending in the database, but past its expiry at serverTime. */
  displayStatus: OfferStatus | 'lapsed';
  offeredAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  source: 'draw' | 'waitlist';
  round: number | null;
}

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

function offerView(p: Row<'placements'>, labels: Map<string, string>, nowMs: number): OfferView {
  return {
    placementId: p.$id,
    week: p.week,
    weekLabel: labels.get(p.week) ?? p.week,
    ageGroup: p.age_group,
    status: p.status,
    displayStatus: displayOfferStatus(p.status, p.expires_at, nowMs),
    offeredAt: iso(p.offered_at),
    expiresAt: iso(p.expires_at),
    respondedAt: iso(p.responded_at),
    source: p.source ?? 'draw',
    round: p.round ?? null,
  };
}

async function weekLabels(db: ServerDb, programId: string) {
  const ledgers = await allRows(db, 'seat_ledger', [Query.equal('program_id', programId)]);
  return { ledgers, labels: new Map(ledgers.map((l) => [l.week, l.label ?? l.week])) };
}

const waitingAhead = async (db: ServerDb, e: Row<'waitlist'>) =>
  (await db.listRows('waitlist', [
    Query.equal('program_id', e.program_id),
    Query.equal('week', e.week),
    Query.equal('age_group', e.age_group),
    Query.equal('status', 'waiting'),
    Query.lessThan('position', e.position),
    Query.limit(1),
  ])).total;

// ---- families --------------------------------------------------------------------

export async function familyOffers(db: ServerDb, userId: string, programId?: string) {
  const { familyId } = await requireHousehold(db, userId);
  const scope = [Query.equal('family_id', familyId), ...(programId ? [Query.equal('program_id', programId)] : [])];
  const [placements, waits, kids, now] = await Promise.all([
    allRows(db, 'placements', scope),
    allRows(db, 'waitlist', scope),
    allRows(db, 'children', [Query.equal('family_id', familyId)]),
    serverNow(db),
  ]);
  const childName = new Map(kids.map((c) => [c.$id, c.first_name]));
  const programIds = [...new Set([...placements.map((p) => p.program_id), ...waits.map((w) => w.program_id)])];
  const programs = await Promise.all(
    programIds.map(async (id) => {
      const program = await findRow(db, 'programs', id);
      if (!program) return null;
      const { labels } = await weekLabels(db, id);
      const offers = placements
        .filter((p) => p.program_id === id)
        .sort((a, b) => a.week.localeCompare(b.week) || a.child_id.localeCompare(b.child_id))
        .map((p) => ({ ...offerView(p, labels, now.getTime()), childId: p.child_id, childName: childName.get(p.child_id) ?? 'Your child' }));
      const waitlist = await Promise.all(
        waits
          .filter((w) => w.program_id === id)
          .sort((a, b) => a.week.localeCompare(b.week) || a.position - b.position)
          .map(async (w) => ({
            entryId: w.$id,
            childId: w.child_id,
            childName: childName.get(w.child_id) ?? 'Your child',
            week: w.week,
            weekLabel: labels.get(w.week) ?? w.week,
            ageGroup: w.age_group,
            position: w.position,
            status: w.status,
            ahead: w.status === 'waiting' ? await waitingAhead(db, w) : null,
          })),
      );
      return {
        programId: id,
        name: program.name,
        timezone: program.timezone,
        synthetic: program.synthetic,
        status: program.status,
        offersIssuedAt: iso(program.offers_issued_at),
        offersSweptAt: iso(program.offers_swept_at),
        offers,
        waitlist,
      };
    }),
  );
  return { serverTime: now.toISOString(), programs: programs.filter((p) => p !== null) };
}

const TARGET: Record<OfferResponse, OfferStatus> = { accept: 'accepted', decline: 'declined', giveBack: 'released' };

export async function respondToOffers(
  db: ServerDb,
  userId: string,
  req: { programId: string; placementIds: string[]; response: OfferResponse; idempotencyKey: string },
) {
  const { familyId } = await requireHousehold(db, userId);
  return respondForHousehold(db, familyId, req);
}

/**
 * A household's reply to its own offers. Families reach it through
 * respondToOffers (household from the caller's session); the judge sandbox
 * uses it to reply on behalf of its SYNTHETIC households (sandbox.ts), so a
 * demo reply runs exactly the code a real family's does.
 */
export async function respondForHousehold(
  db: ServerDb,
  familyId: string,
  req: { programId: string; placementIds: string[]; response: OfferResponse; idempotencyKey: string },
) {
  const program = await findRow(db, 'programs', req.programId);
  if (!program) throw new AppError('not_found', 'Program not found.');
  if (!program.offers_issued_at) throw new AppError('locked', 'Offers for this program have not been issued yet.');
  const to = TARGET[req.response];
  const result = await transitionOffers(db, {
    programId: program.$id,
    placementIds: req.placementIds,
    to,
    ...(to === 'released' ? {} : { clock: 'before_expiry' as const }),
    // Keyed per household: two guardians retrying their own clicks never collide.
    idempotency: { key: `${familyId}:${req.idempotencyKey}`, fingerprint: sha256Hex(canonicalJson({ response: req.response, placementIds: [...req.placementIds].sort() })) },
    authorize: (rows) => {
      if (rows.some((r) => r.family_id !== familyId)) throw new AppError('not_found', 'Offer not found.');
    },
  });
  let promoted = 0;
  if (result.status === 'changed' && releasesSeat(to)) {
    promoted = (await afterRelease(db, program.$id, result.placements.map(toChange), 'offers_released')).promoted.length;
  } else if (result.status === 'changed') {
    await refreshOfferStats(db, program.$id).catch(() => undefined);
  }
  const { labels } = await weekLabels(db, program.$id);
  const now = Date.parse(result.at ?? new Date().toISOString());
  return { status: result.status, offers: result.placements.map((p) => offerView(p, labels, now)), promoted };
}

// ---- organisers ------------------------------------------------------------------

export async function organiserOffersOverview(db: ServerDb, program: Row<'programs'>) {
  const scope = [Query.equal('program_id', program.$id)];
  const [{ ledgers, labels }, placements, waits, apps, now] = await Promise.all([
    weekLabels(db, program.$id),
    allRows(db, 'placements', scope),
    allRows(db, 'waitlist', scope),
    allRows(db, 'applications', scope),
    serverNow(db),
  ]);
  const publicId = new Map(apps.map((a) => [a.family_id, a.public_id]));
  const key = (week: string, ageGroup: string) => `${week}\u0000${ageGroup}`;
  const count = (rows: { week: string; age_group: string; status: string }[], week: string, ageGroup: string, status: string) =>
    rows.filter((r) => key(r.week, r.age_group) === key(week, ageGroup) && r.status === status).length;
  return {
    serverTime: now.toISOString(),
    status: program.status,
    offersIssuedAt: iso(program.offers_issued_at),
    offersSweptAt: iso(program.offers_swept_at),
    sessions: ledgers
      .sort((a, b) => a.week.localeCompare(b.week) || a.age_group.localeCompare(b.age_group))
      .map((l) => ({
        week: l.week,
        weekLabel: labels.get(l.week) ?? l.week,
        ageGroup: l.age_group,
        capacity: l.capacity,
        taken: l.taken,
        pending: count(placements, l.week, l.age_group, 'offered'),
        accepted: count(placements, l.week, l.age_group, 'accepted'),
        waiting: count(waits, l.week, l.age_group, 'waiting'),
      })),
    offers: placements
      .sort((a, b) => a.week.localeCompare(b.week) || a.age_group.localeCompare(b.age_group) || (a.expires_at ?? '').localeCompare(b.expires_at ?? ''))
      .map((p) => ({ ...offerView(p, labels, now.getTime()), publicId: publicId.get(p.family_id) ?? '', ref: ticketRowId(p.program_id, p.child_id) })),
    waitlist: waits
      .sort((a, b) => a.week.localeCompare(b.week) || a.age_group.localeCompare(b.age_group) || a.position - b.position)
      .map((w) => ({
        entryId: w.$id,
        week: w.week,
        weekLabel: labels.get(w.week) ?? w.week,
        ageGroup: w.age_group,
        position: w.position,
        rank: w.rank ?? null,
        status: w.status,
        publicId: publicId.get(w.family_id) ?? '',
        ref: ticketRowId(w.program_id, w.child_id),
      })),
  };
}

export async function cancelOffers(db: ServerDb, program: Row<'programs'>, userId: string, placementIds: string[], idempotencyKey: string) {
  if (!program.offers_issued_at) throw new AppError('locked', 'Offers for this program have not been issued yet.');
  const result = await transitionOffers(db, {
    programId: program.$id,
    placementIds,
    to: 'cancelled',
    idempotency: { key: `org:${userId}:${idempotencyKey}`, fingerprint: sha256Hex(canonicalJson({ cancel: [...placementIds].sort() })) },
  });
  const promoted = result.status === 'changed' ? (await afterRelease(db, program.$id, result.placements.map(toChange), 'offers_cancelled')).promoted.length : 0;
  return { status: result.status, cancelled: result.placements.map((p) => p.$id), promoted };
}

/**
 * Organiser "process now": the same sweep the hourly job runs, for one program, within the api timeout.
 * The deadline leaves room for the audit entry, the stats refresh and the response inside the 30 s
 * synchronous execution limit (measured on Cloud: a sweep step costs roughly 2-3 s per offer at 4-way concurrency).
 */
export const processOffers = (db: ServerDb, programId: string) => runOfferSweep(db, { deadline: Date.now() + 8_000, programId });
