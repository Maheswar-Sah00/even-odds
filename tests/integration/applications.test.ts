/**
 * Task 7 application rules against REAL TablesDB (and the deployed Function
 * for client-tampering checks). All data is synthetic and removed afterwards.
 */
import { ExecutionMethod, Functions } from 'appwrite';
import { ID, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../functions/shared/app-error.ts';
import { applicationRowId, preferenceRowId, submitApplication, withdrawApplication } from '../../functions/shared/applications.ts';
import { addChild, createHousehold, setHome } from '../../functions/shared/household.ts';
import { createProgram, publishProgram, replaceSessions, replaceZones } from '../../functions/shared/organiser.ts';
import { submitApplicationSchema, type SubmitApplicationInput } from '../../shared/application-input.ts';
import type { TableKey } from '../../shared/config.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import { aw, createSyntheticUser, db, RUN_ID, serverEnv } from './helpers/server.ts';

const secret = serverEnv.childKeySecret ?? '';
const teamId = `itest-app-${RUN_ID}`.slice(0, 36);
const programId = `ita-${RUN_ID}`.slice(0, 36);
type U = Awaited<ReturnType<typeof createSyntheticUser>>;
let A: U, B: U;
let familyA = '', familyB = '';
let ada = '', bob = '';
const key = () => `k-${ID.unique()}-${ID.unique()}`;

// W1/W2 have 6-8 and 9-11 groups; W3 only 9-11. Ada is 7, Bob is 10 at the start of each week.
const CSV = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,6-8,6,8,2\nW1,2027-06-21,9-11,9,11,2\nW2,2027-06-28,6-8,6,8,2\nW2,2027-06-28,9-11,9,11,2\nW3,2027-07-05,9-11,9,11,2\n';

const expectAppError = async (p: Promise<unknown>, code: AppError['code'], field?: string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (field) expect((err as AppError).field).toBe(field);
  return err as AppError;
};

const base = (patch: Partial<SubmitApplicationInput> = {}): SubmitApplicationInput => ({
  programId,
  siblingMode: 'together_preferred',
  children: [
    { childId: ada, rankedWeeks: ['W2', 'W1'], requestedWeeks: 2 },
    { childId: bob, rankedWeeks: ['W1', 'W3'], requestedWeeks: 1 },
  ],
  idempotencyKey: key(),
  ...patch,
});

beforeAll(async () => {
  if (secret.length < 32) throw new Error('CHILD_KEY_SECRET must be set');
  [A, B] = await Promise.all([createSyntheticUser('appA'), createSyntheticUser('appB')]);
  await aw.teams.create({ teamId, name: `[SYNTHETIC] organisers ${RUN_ID}` });
  const now = Date.now();
  await createProgram(
    db,
    teamId,
    programDetailsSchema.parse({
      name: `[SYNTHETIC] app test ${RUN_ID}`,
      timezone: 'America/New_York',
      windowOpen: new Date(now - 3600_000).toISOString(),
      windowClose: new Date(now + 3 * 86400_000).toISOString(),
      maxWeeks: 2,
      defaultTier: 1,
      tierLabels: { '0': 'Zone', '1': 'Everyone else' },
    }),
    { programId, synthetic: true },
  );
  await replaceSessions(db, teamId, programId, parseSessionsCsv(CSV).sessions);
  await replaceZones(db, teamId, programId, [{ name: 'Z', tier: 0, area: [[[-77.31, 38.84], [-77.29, 38.84], [-77.29, 38.86], [-77.31, 38.86], [-77.31, 38.84]]] }]);
  await publishProgram(db, teamId, programId);

  familyA = (await createHousehold(db, A.userId)).familyId;
  familyB = (await createHousehold(db, B.userId)).familyId;
  ada = (await addChild(db, A.userId, { firstName: 'Ada', lastName: 'Synthetic', birthdate: '2019-12-10' }, () => ID.unique())).$id;
  bob = (await addChild(db, A.userId, { firstName: 'Bob', lastName: 'Synthetic', birthdate: '2016-08-01' }, () => ID.unique())).$id;
  await setHome(db, A.userId, [-77.30, 38.85]); // inside zone Z
});

afterAll(async () => {
  const byProgram: TableKey[] = ['preferences', 'applications', 'tickets', 'link_requests', 'idempotency', 'seat_ledger', 'zones', 'audit_log'];
  for (const t of byProgram) {
    const { rows } = await db.listRows(t, [Query.equal('program_id', programId), Query.limit(200)]);
    await Promise.all(rows.map((r) => db.deleteRow(t, r.$id)));
  }
  for (const familyId of [familyA, familyB]) {
    for (const t of ['children', 'family_locations', 'guardians'] as TableKey[]) {
      const { rows } = await db.listRows(t, [Query.equal('family_id', familyId), Query.limit(100)]);
      await Promise.all(rows.map((r) => db.deleteRow(t, r.$id)));
    }
    await db.deleteRow('families', familyId).catch(() => undefined);
  }
  await db.deleteRow('programs', programId).catch(() => undefined);
  await aw.teams.delete({ teamId }).catch(() => undefined);
  await Promise.all([A.remove(), B.remove()]);
});

describe('submitting an application', () => {
  let publicId = '';
  let submittedAt = '';

  it('stores server-computed tier, age groups and a pseudonymous public ID', async () => {
    const r = await submitApplication(db, secret, A.userId, base());
    expect(r).toMatchObject({ status: 'submitted', claimedTier: 0, nearBoundary: false, late: false });
    expect(r.publicId).toMatch(/^[0-9a-f]{32}$/);
    publicId = r.publicId;
    const app = await db.getRow('applications', applicationRowId(programId, familyA));
    expect(app).toMatchObject({ status: 'submitted', sibling_mode: 'together_preferred', claimed_tier: 0, public_id: publicId });
    submittedAt = app.submitted_at ?? '';
    const pref = await db.getRow('preferences', preferenceRowId(programId, ada));
    expect(pref).toMatchObject({ ranked_weeks: ['W2', 'W1'], ranked_age_groups: ['6-8', '6-8'], requested_weeks: 2 });
    const bobPref = await db.getRow('preferences', preferenceRowId(programId, bob));
    expect(bobPref.ranked_age_groups).toEqual(['9-11', '9-11']);
    expect((await db.listRows('tickets', [Query.equal('program_id', programId), Query.equal('family_id', familyA)])).total).toBe(2);
  });

  it('a repeated request (same idempotency key, even 4 at once) changes nothing', async () => {
    const input = base({ siblingMode: 'independent' });
    const results = await Promise.all([1, 2, 3, 4].map(() => submitApplication(db, secret, A.userId, input)));
    expect(results.filter((r) => r.status === 'updated')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'replayed')).toHaveLength(3);
    const again = await submitApplication(db, secret, A.userId, input);
    expect(again.status).toBe('replayed');
  });

  it('editing before the freeze keeps the same receipt and first submission time', async () => {
    const r = await submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 1 }] }));
    expect(r).toMatchObject({ status: 'updated', publicId });
    const app = await db.getRow('applications', applicationRowId(programId, familyA));
    expect(app.submitted_at).toBe(submittedAt);
    // Bob was dropped: his preference and ticket are gone.
    await expect(db.getRow('preferences', preferenceRowId(programId, bob))).rejects.toMatchObject({ mapped: { kind: 'not_found' } });
    expect((await db.listRows('tickets', [Query.equal('program_id', programId), Query.equal('child_id', bob)])).total).toBe(0);
  });
});

describe('server-side validation', () => {
  it('rejects a week the child is too young for (age on the first day of the week)', async () => {
    await expectAppError(submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W3'], requestedWeeks: 1 }] })), 'validation', 'children.0.rankedWeeks');
  });

  it('rejects unknown weeks and asking for more weeks than allowed', async () => {
    await expectAppError(submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W9'], requestedWeeks: 1 }] })), 'validation');
    await expectAppError(submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1', 'W2'], requestedWeeks: 3 }] })), 'validation', 'children.0.requestedWeeks');
    await expectAppError(submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 2 }] })), 'validation', 'children.0.requestedWeeks');
  });

  it('rejects "together only" when the siblings share no week', async () => {
    await expectAppError(
      submitApplication(db, secret, A.userId, base({ siblingMode: 'together_only', children: [{ childId: ada, rankedWeeks: ['W2'], requestedWeeks: 1 }, { childId: bob, rankedWeeks: ['W3'], requestedWeeks: 1 }] })),
      'validation',
      'siblingMode',
    );
  });

  it("rejects another household's child, and a duplicate of an existing ticket", async () => {
    await expectAppError(submitApplication(db, secret, B.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 1 }] })), 'not_found');
    const copy = (await addChild(db, B.userId, { firstName: 'ADA', lastName: 'synthetic', birthdate: '2019-12-10' }, () => ID.unique())).$id;
    await expectAppError(submitApplication(db, secret, B.userId, base({ children: [{ childId: copy, rankedWeeks: ['W1'], requestedWeeks: 1 }] })), 'conflict');
    await expect(db.getRow('applications', applicationRowId(programId, familyB))).rejects.toBeDefined();
  });

  it('the strict schema rejects client-supplied tiers or extra fields', () => {
    const tampered = { ...base(), claimed_tier: 0 };
    expect(submitApplicationSchema.safeParse(tampered).success).toBe(false);
    const childTamper = { ...base(), children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 1, verified_tier: 0 }] };
    expect(submitApplicationSchema.safeParse(childTamper).success).toBe(false);
  });

  it('the deployed Function refuses a payload carrying a tier', async () => {
    const ex = await new Functions(A.client).createExecution({
      functionId: 'api',
      body: JSON.stringify({ area: 'household', action: 'submitApplication', application: { ...base(), verified_tier: 0 } }),
      async: false,
      method: ExecutionMethod.POST,
    });
    expect(ex.responseStatusCode).toBe(400);
    expect(JSON.parse(ex.responseBody)).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
});

describe('registration window', () => {
  it('is closed after window_close unless the program has an explicit late policy', async () => {
    const program = await db.getRow('programs', programId);
    await db.updateRow('programs', programId, { window_close: new Date(Date.now() - 60_000).toISOString() });
    try {
      await expectAppError(submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 1 }] })), 'locked');
      await db.updateRow('programs', programId, { late_policy: 'accept_late' });
      const late = await submitApplication(db, secret, A.userId, base({ children: [{ childId: ada, rankedWeeks: ['W1'], requestedWeeks: 1 }] }));
      // The household applied on time earlier, so it keeps its on-time status.
      expect(late.late).toBe(false);
      // A household applying for the first time now is marked late.
      const cara = (await addChild(db, B.userId, { firstName: 'Cara', lastName: 'Synthetic', birthdate: '2017-03-03' }, () => ID.unique())).$id;
      const newcomer = await submitApplication(db, secret, B.userId, base({ children: [{ childId: cara, rankedWeeks: ['W3'], requestedWeeks: 1 }] }));
      expect(newcomer).toMatchObject({ status: 'submitted', late: true, claimedTier: 1 });
    } finally {
      await db.updateRow('programs', programId, { window_close: program.window_close, late_policy: null });
    }
  });

  it('withdrawal works before freeze and is refused after', async () => {
    await expect(withdrawApplication(db, A.userId, programId)).resolves.toEqual({ status: 'withdrawn' });
    await db.updateRow('programs', programId, { status: 'frozen' });
    try {
      await expectAppError(withdrawApplication(db, A.userId, programId), 'locked');
      await expectAppError(submitApplication(db, secret, A.userId, base()), 'locked');
    } finally {
      await db.updateRow('programs', programId, { status: 'open' });
    }
  });
});
