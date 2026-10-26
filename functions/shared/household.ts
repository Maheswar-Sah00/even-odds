import { randomInt } from 'node:crypto';
import { Permission, Query, Role, type Users } from 'node-appwrite';
import type { TableKey } from '../../shared/config.ts';
import { ServiceError } from '../../shared/errors.ts';
import { INVITE_ALPHABET, type ChildInput } from '../../shared/household-input.ts';
import { isValidLngLat, type LngLat } from '../../shared/geo.ts';
import { normaliseBirthdate, normaliseName } from '../../shared/identity.ts';
import { AppError } from './app-error.ts';
import { childKey, deterministicId, sha256Hex } from './crypto.ts';
import type { Row, ServerDb } from './db.ts';
import { isDemo } from './namespace.ts';
import { classifyPoint } from './organiser.ts';

/**
 * Household management. Every function takes the CALLER's user ID, which the
 * Function adapter reads from the platform-set x-appwrite-user-id header
 * (clients cannot send x-appwrite-* headers: verified on Cloud). All access
 * checks happen here; row permissions are a second, independent layer.
 *
 * Not-yours and does-not-exist are deliberately indistinguishable (not_found).
 */

export const householdId = (userId: string) => deterministicId('fa', 'household', userId);
export const guardianRowId = (userId: string) => deterministicId('gu', 'guardian', userId);
export const ticketRowId = (programId: string, childId: string) => deterministicId('tk', 'ticket', programId, childId);
const INVITE_TTL_MS = 72 * 3600_000;
const MAX_PENDING_INVITES = 5;

export const isKind = (err: unknown, ...kinds: string[]) => err instanceof ServiceError && kinds.includes(err.mapped.kind);

export async function findRow<K extends TableKey>(db: ServerDb, table: K, rowId: string): Promise<Row<K> | null> {
  try {
    return await db.getRow(table, rowId);
  } catch (err) {
    if (isKind(err, 'not_found')) return null;
    throw err;
  }
}

export async function allRows<K extends TableKey>(db: ServerDb, table: K, queries: string[]): Promise<Row<K>[]> {
  const out: Row<K>[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await db.listRows(table, [...queries, Query.limit(100), Query.offset(offset)]);
    out.push(...page.rows);
    if (page.rows.length < 100) return out;
  }
}

/**
 * A program as the household area may see it: published and PRODUCTION. Demo
 * sandboxes belong to one visitor and are driven only by the demo area, so
 * here they look like they do not exist (Task 14: an outsider could otherwise
 * register tickets or applications into someone else's sandbox).
 */
export async function familyProgram(db: ServerDb, programId: string): Promise<Row<'programs'>> {
  const program = await findRow(db, 'programs', programId);
  if (!program || program.status === 'draft' || isDemo(program)) throw new AppError('not_found', 'Program not found.');
  return program;
}

export async function guardianOf(db: ServerDb, userId: string): Promise<Row<'guardians'> | null> {
  return findRow(db, 'guardians', guardianRowId(userId));
}

export async function requireHousehold(db: ServerDb, userId: string): Promise<{ familyId: string; guardianIds: string[] }> {
  const guardian = await guardianOf(db, userId);
  if (!guardian) throw new AppError('not_found', 'You have not created or joined a household yet.');
  const guardians = await allRows(db, 'guardians', [Query.equal('family_id', guardian.family_id)]);
  return { familyId: guardian.family_id, guardianIds: guardians.map((g) => g.user_id) };
}

export const readFor = (userIds: readonly string[], teams: readonly string[] = []) => [
  ...userIds.map((id) => Permission.read(Role.user(id))),
  ...teams.map((t) => Permission.read(Role.team(t))),
];

// ---- household ---------------------------------------------------------------

export interface HouseholdSummary {
  familyId: string;
  role: 'primary' | 'linked';
  guardians: { userId: string; role: 'primary' | 'linked'; email: string; isYou: boolean }[];
  pendingInvites: number;
}

export async function getHousehold(db: ServerDb, users: Users, userId: string): Promise<HouseholdSummary | null> {
  const me = await guardianOf(db, userId);
  if (!me) return null;
  const guardians = await allRows(db, 'guardians', [Query.equal('family_id', me.family_id)]);
  const emails = await Promise.all(guardians.map((g) => users.get({ userId: g.user_id }).then((u) => u.email, () => '')));
  const invites = await db.listRows('guardian_invites', [Query.equal('family_id', me.family_id), Query.equal('status', 'pending'), Query.greaterThan('expires_at', new Date().toISOString()), Query.limit(1)]);
  return {
    familyId: me.family_id,
    role: me.role,
    guardians: guardians.map((g, i) => ({ userId: g.user_id, role: g.role, email: emails[i] ?? '', isYou: g.user_id === userId })),
    pendingInvites: invites.total,
  };
}

/** Idempotent: returns the caller's existing household if there is one. */
export async function createHousehold(db: ServerDb, userId: string, opts: { synthetic?: boolean } = {}): Promise<{ familyId: string; created: boolean }> {
  const existing = await guardianOf(db, userId);
  if (existing) return { familyId: existing.family_id, created: false };

  const familyId = householdId(userId);
  const tx = await db.transactions.begin(60);
  try {
    await db.createRow('families', familyId, { created_by: userId, synthetic: opts.synthetic ?? false }, { permissions: readFor([userId]), transactionId: tx.$id });
    await db.createRow('guardians', guardianRowId(userId), { user_id: userId, family_id: familyId, role: 'primary' }, { permissions: readFor([userId]), transactionId: tx.$id });
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
    return { familyId, created: true };
  } catch (err) {
    // A concurrent request for the same user won (deterministic IDs collide).
    if (!isKind(err, 'transaction_conflict', 'conflict')) throw err;
    const winner = await guardianOf(db, userId);
    if (!winner) throw err;
    return { familyId: winner.family_id, created: false };
  }
}

// ---- children ----------------------------------------------------------------

const sameIdentity = (a: { first_name: string; last_name: string; birthdate: string }, b: ChildInput) =>
  normaliseName(a.first_name) === normaliseName(b.firstName) &&
  normaliseName(a.last_name) === normaliseName(b.lastName) &&
  normaliseBirthdate(a.birthdate) === b.birthdate;

export async function addChild(db: ServerDb, userId: string, input: ChildInput, newId: () => string): Promise<Row<'children'>> {
  const { familyId, guardianIds } = await requireHousehold(db, userId);
  const siblings = await allRows(db, 'children', [Query.equal('family_id', familyId)]);
  if (siblings.some((c) => sameIdentity(c, input))) {
    throw new AppError('conflict', 'This child is already in your household.');
  }
  return db.createRow(
    'children',
    newId(),
    { family_id: familyId, first_name: input.firstName.trim(), last_name: input.lastName.trim(), birthdate: `${input.birthdate}T00:00:00.000Z` },
    { permissions: readFor(guardianIds) },
  );
}

async function requireOwnChild(db: ServerDb, userId: string, childId: string) {
  const household = await requireHousehold(db, userId);
  const child = await findRow(db, 'children', childId);
  if (!child || child.family_id !== household.familyId) throw new AppError('not_found', 'Child not found.');
  return { ...household, child };
}

/**
 * Edits a child. Their program tickets are re-keyed in the same transaction;
 * edits are refused while any ticket is in a program that is no longer open,
 * because frozen draw inputs must not change.
 */
export async function updateChild(db: ServerDb, secret: string, userId: string, childId: string, input: ChildInput): Promise<Row<'children'>> {
  const { child, familyId } = await requireOwnChild(db, userId, childId);
  const tickets = await allRows(db, 'tickets', [Query.equal('child_id', childId)]);
  const programs = await Promise.all(tickets.map((t) => db.getRow('programs', t.program_id)));
  const locked = programs.find((p) => p.status !== 'open' && p.status !== 'draft');
  if (locked) throw new AppError('locked', `Details can't be changed because "${locked.name}" has closed applications. Contact the organiser.`);

  const tx = await db.transactions.begin(60);
  try {
    await db.updateRow('children', child.$id, { first_name: input.firstName.trim(), last_name: input.lastName.trim(), birthdate: `${input.birthdate}T00:00:00.000Z` }, { transactionId: tx.$id });
    for (const t of tickets) {
      const key = childKey(secret, { programId: t.program_id, firstName: input.firstName, lastName: input.lastName, birthdate: input.birthdate });
      await db.updateRow('tickets', t.$id, { child_key: key }, { transactionId: tx.$id });
    }
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
  } catch (err) {
    if (isKind(err, 'transaction_conflict')) {
      // Like registering, editing into another household's child notifies that household (Task 14),
      // so repeated identity probing is visible to the family being probed.
      for (const t of tickets) {
        await notifyTicketHolder(db, t.program_id, childKey(secret, { programId: t.program_id, firstName: input.firstName, lastName: input.lastName, birthdate: input.birthdate }), familyId);
      }
      throw new AppError('conflict', 'These details match a child who already has a ticket in another household, or the record changed at the same time. Nothing was saved.');
    }
    throw err;
  }
  return db.getRow('children', child.$id);
}

// ---- guardian invites --------------------------------------------------------

export function generateInviteCode(): string {
  return Array.from({ length: 10 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');
}

export async function createInvite(db: ServerDb, userId: string, newId: () => string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
  const { familyId } = await requireHousehold(db, userId);
  const pending = await db.listRows('guardian_invites', [Query.equal('family_id', familyId), Query.equal('status', 'pending'), Query.greaterThan('expires_at', now.toISOString()), Query.limit(1)]);
  if (pending.total >= MAX_PENDING_INVITES) throw new AppError('rate_limited', `You already have ${MAX_PENDING_INVITES} unused invites. Wait for one to be used or expire.`);
  const code = generateInviteCode();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  await db.createRow('guardian_invites', newId(), { family_id: familyId, code_hash: sha256Hex(code), created_by: userId, expires_at: expiresAt, status: 'pending' });
  return { code, expiresAt };
}

export async function acceptInvite(db: ServerDb, userId: string, code: string, now = new Date()): Promise<{ familyId: string }> {
  const { rows } = await db.listRows('guardian_invites', [Query.equal('code_hash', sha256Hex(code)), Query.limit(1)]);
  const invite = rows[0];
  const current = await guardianOf(db, userId);
  if (invite && current?.family_id === invite.family_id) return { familyId: invite.family_id }; // already joined: idempotent
  if (!invite || invite.status !== 'pending') throw new AppError('not_found', 'That invite code is not valid or has already been used.');
  if (new Date(invite.expires_at) <= now) throw new AppError('expired', 'That invite has expired. Ask for a new one.');
  if (current) throw new AppError('conflict', 'You already belong to a household. An account can belong to one household.');

  const tx = await db.transactions.begin(60);
  try {
    await db.createRow('guardians', guardianRowId(userId), { user_id: userId, family_id: invite.family_id, role: 'linked' }, { transactionId: tx.$id });
    await db.updateRow('guardian_invites', invite.$id, { status: 'accepted', accepted_by: userId }, { transactionId: tx.$id });
  } catch (err) {
    await db.transactions.rollback(tx.$id).catch(() => undefined);
    throw err;
  }
  try {
    await db.transactions.commit(tx.$id);
  } catch (err) {
    if (isKind(err, 'transaction_conflict')) {
      const joined = await guardianOf(db, userId);
      if (joined?.family_id === invite.family_id) return { familyId: invite.family_id };
      throw new AppError('conflict', 'That invite was just used by someone else.');
    }
    throw err;
  }
  await syncHouseholdPermissions(db, invite.family_id);
  return { familyId: invite.family_id };
}

/**
 * Re-grants read access on every household row to the current guardians (and
 * program organiser teams where relevant). Idempotent; safe to rerun.
 * family_locations never gets organiser access.
 */
export async function syncHouseholdPermissions(db: ServerDb, familyId: string): Promise<void> {
  const guardians = (await allRows(db, 'guardians', [Query.equal('family_id', familyId)])).map((g) => g.user_id);
  const teamCache = new Map<string, string>();
  const teamOf = async (programId: string) => {
    if (!teamCache.has(programId)) teamCache.set(programId, (await db.getRow('programs', programId)).org_team_id);
    return teamCache.get(programId) ?? '';
  };

  await db.updateRow('families', familyId, {}, { permissions: readFor(guardians) });
  for (const g of guardians) await db.updateRow('guardians', guardianRowId(g), {}, { permissions: readFor(guardians) });
  for (const table of ['children', 'family_locations', 'link_requests', 'tickets'] as const) {
    for (const row of await allRows(db, table, [Query.equal('family_id', familyId)])) {
      await db.updateRow(table, row.$id, {}, { permissions: readFor(guardians) });
    }
  }
  for (const table of ['applications', 'preferences', 'placements', 'waitlist'] as const) {
    for (const row of await allRows(db, table, [Query.equal('family_id', familyId)])) {
      await db.updateRow(table, row.$id, {}, { permissions: readFor(guardians, [await teamOf(row.program_id)]) });
    }
  }
}

// ---- tickets and duplicate handling -----------------------------------------

export type RegisterTicketResult =
  | { status: 'registered'; ticketId: string }
  | { status: 'already_registered'; ticketId: string }
  /** Another household holds a ticket for a child with the same identity. No details are returned. */
  | { status: 'possible_duplicate' };

/** Accepting applications now? Late submissions only under an explicit accept_late policy, before freeze. */
export function applicationWindow(program: Row<'programs'>, now: Date): { open: boolean; late: boolean } {
  if (program.status !== 'open' || now < new Date(program.window_open)) return { open: false, late: false };
  if (now <= new Date(program.window_close)) return { open: true, late: false };
  return program.late_policy === 'accept_late' ? { open: true, late: true } : { open: false, late: false };
}

/**
 * Creates the child's ticket for a program, or finds it. If another household
 * already holds a ticket for a child with the same identity, nothing is
 * revealed to the caller; the existing household gets a link request.
 */
export async function ensureTicket(
  db: ServerDb,
  secret: string,
  household: { familyId: string; guardianIds: string[] },
  program: Row<'programs'>,
  child: Row<'children'>,
): Promise<RegisterTicketResult> {
  const { familyId, guardianIds } = household;
  const programId = program.$id;
  const ticketId = ticketRowId(programId, child.$id);
  const own = await findRow(db, 'tickets', ticketId);
  if (own) return { status: 'already_registered', ticketId };

  const key = childKey(secret, { programId, firstName: child.first_name, lastName: child.last_name, birthdate: child.birthdate });
  try {
    // Guardians only: organisers never need tickets, and child_key would let them confirm guessed identities (Task 14).
    await db.createRow('tickets', ticketId, { program_id: programId, child_id: child.$id, family_id: familyId, child_key: key }, { permissions: readFor(guardianIds) });
    return { status: 'registered', ticketId };
  } catch (err) {
    if (!isKind(err, 'conflict')) throw err;
  }

  // Either our own concurrent request won, or another household holds this child's ticket.
  if (await findRow(db, 'tickets', ticketId)) return { status: 'already_registered', ticketId };
  await notifyTicketHolder(db, programId, key, familyId);
  return { status: 'possible_duplicate' };
}

/**
 * Tells the household holding a ticket with this child_key that another household tried to
 * register the same child (a link request; no details either way).
 */
async function notifyTicketHolder(db: ServerDb, programId: string, key: string, familyId: string): Promise<void> {
  const { rows } = await db.listRows('tickets', [Query.equal('program_id', programId), Query.equal('child_key', key), Query.limit(1)]);
  const holder = rows[0];
  if (holder && holder.family_id !== familyId) {
    const holderGuardians = (await allRows(db, 'guardians', [Query.equal('family_id', holder.family_id)])).map((g) => g.user_id);
    const requesterHash = sha256Hex(`link-request\n${familyId}`);
    try {
      await db.createRow(
        'link_requests',
        deterministicId('lr', holder.$id, requesterHash),
        { program_id: programId, family_id: holder.family_id, ticket_id: holder.$id, requester_hash: requesterHash, status: 'open' },
        { permissions: readFor(holderGuardians) },
      );
    } catch (err) {
      if (!isKind(err, 'conflict')) throw err; // already notified
    }
  }
}

export async function registerTicket(db: ServerDb, secret: string, userId: string, programId: string, childId: string, now = new Date()): Promise<RegisterTicketResult> {
  const { familyId, guardianIds, child } = await requireOwnChild(db, userId, childId);
  const program = await familyProgram(db, programId);
  if (!applicationWindow(program, now).open) throw new AppError('locked', 'This program is not accepting applications right now.');
  return ensureTicket(db, secret, { familyId, guardianIds }, program, child);
}

export async function dismissLinkRequest(db: ServerDb, userId: string, linkRequestId: string): Promise<void> {
  const { familyId } = await requireHousehold(db, userId);
  const request = await findRow(db, 'link_requests', linkRequestId);
  if (!request || request.family_id !== familyId) throw new AppError('not_found', 'Request not found.');
  await db.updateRow('link_requests', linkRequestId, { status: 'dismissed' });
}

// ---- home location and zone tier ---------------------------------------------

export const locationRowId = (familyId: string) => deterministicId('fl', 'location', familyId);

/** Stores the household's home point. Readable by its guardians only, never organisers. */
export async function setHome(db: ServerDb, userId: string, point: LngLat): Promise<void> {
  if (!isValidLngLat(point)) throw new AppError('validation', 'Choose a location on the map.', 'home');
  const { familyId, guardianIds } = await requireHousehold(db, userId);
  await db.upsertRows('family_locations', [{ $id: locationRowId(familyId), $permissions: readFor(guardianIds), family_id: familyId, home: point }]);
}

/** The tier the household's home earns in a published program (server-computed; never client-supplied). */
export async function classifyMyHome(db: ServerDb, userId: string, programId: string): Promise<{ tier: number; tierLabel: string; nearBoundary: boolean } | null> {
  const { familyId } = await requireHousehold(db, userId);
  const program = await familyProgram(db, programId);
  const location = await findRow(db, 'family_locations', locationRowId(familyId));
  if (!location) return null;
  const result = await classifyPoint(db, program, location.home);
  const labels = JSON.parse(program.tier_labels ?? '{}') as Record<string, string>;
  return { tier: result.tier, tierLabel: labels[String(result.tier)] ?? `Tier ${result.tier}`, nearBoundary: result.nearBoundary };
}
