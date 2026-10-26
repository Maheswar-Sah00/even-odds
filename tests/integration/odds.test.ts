/**
 * Task 8: the odds job against REAL TablesDB, plus the deployed, scheduled
 * odds Function. Applications here are synthetic rows written with the server
 * key (the wizard path is covered by applications.test.ts).
 */
import { Client as BrowserClient, ExecutionMethod, Functions as BrowserFunctions, TablesDB as BrowserTablesDB } from 'appwrite';
import { Functions, Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId } from '../../functions/shared/crypto.ts';
import { oddsRowId, runOddsForProgram } from '../../functions/shared/odds-job.ts';
import { createProgram, publishProgram, replaceSessions } from '../../functions/shared/organiser.ts';
import type { TableKey } from '../../shared/config.ts';
import type { TierOdds } from '../../shared/odds.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../shared/program-input.ts';
import { aw, createSyntheticUser, db, RUN_ID, serverEnv } from './helpers/server.ts';

const teamId = serverEnv.organiserTeamId ?? 'organisers';
const programId = `ito-${RUN_ID}`.slice(0, 36);
const guest = () => new BrowserTablesDB(new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId));
const ids: string[] = [];
const NOW = new Date();

beforeAll(async () => {
  await createProgram(
    db,
    teamId,
    programDetailsSchema.parse({
      name: `[SYNTHETIC] odds test ${RUN_ID}`,
      timezone: 'America/New_York',
      windowOpen: new Date(NOW.getTime() - 3600_000).toISOString(),
      windowClose: new Date(NOW.getTime() + 5 * 86400_000).toISOString(),
      maxWeeks: 1,
      defaultTier: 1,
      tierLabels: { '0': 'Zone', '1': 'Everyone else' },
    }),
    { programId, synthetic: true },
  );
  await replaceSessions(db, teamId, programId, parseSessionsCsv('week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,6-8,6,8,3\n').sessions);
  await publishProgram(db, teamId, programId);
  // 6 children in tier 0 and 2 in tier 1, all wanting W1 (3 seats).
  for (let i = 0; i < 8; i++) {
    const familyId = `fam-odds-${String(i)}-${RUN_ID}`.slice(0, 36);
    ids.push(familyId);
    await db.createRow('applications', `app${String(i)}-${RUN_ID}`.slice(0, 36), {
      program_id: programId, family_id: familyId, public_id: newPublicId(), sibling_mode: 'independent', status: 'submitted',
      claimed_tier: i < 6 ? 0 : 1, submitted_at: new Date(NOW.getTime() - (i + 1) * 61_000).toISOString(), synthetic: true,
    });
    await db.createRow('preferences', `pref${String(i)}-${RUN_ID}`.slice(0, 36), {
      program_id: programId, family_id: familyId, child_id: `child-${String(i)}-${RUN_ID}`.slice(0, 36), ranked_weeks: ['W1'], ranked_age_groups: ['6-8'], requested_weeks: 1,
    });
  }
});

afterAll(async () => {
  for (const t of ['preferences', 'applications', 'seat_ledger', 'audit_log', 'odds_snapshots'] as TableKey[]) {
    const { rows } = await db.listRows(t, [Query.equal('program_id', programId), Query.limit(100)]);
    await Promise.all(rows.map((r) => db.deleteRow(t, r.$id)));
  }
  await db.deleteRow('programs', programId).catch(() => undefined);
});

const tiersOf = async () => JSON.parse((await db.getRow('odds_snapshots', oddsRowId(programId))).tiers) as TierOdds[];

describe('odds job (real TablesDB)', () => {
  it('publishes a public, aggregate-only snapshot', async () => {
    const out = await runOddsForProgram(db, await db.getRow('programs', programId), NOW);
    expect(out.status).toBe('computed');
    const row = await guest().getRow({ databaseId: serverEnv.databaseId, tableId: 'odds_snapshots', rowId: oddsRowId(programId) });
    expect(row).toMatchObject({ applicants: 8, children: 8, seats: 3, frozen: false, model_version: 'odds-v1' });
    const tiers = JSON.parse(String(row['tiers'])) as TierOdds[];
    expect(tiers.find((t) => t.tier === 0)).toMatchObject({ children: 6, pAtLeastOne: 0.5, band: 'About even' });
    // Tier 1 has 2 children: suppressed for privacy (and always 0 here, since tier 0 fills every seat).
    expect(tiers.find((t) => t.tier === 1)).toMatchObject({ children: 2, pAtLeastOne: null, band: null });
    const sessions = JSON.parse(String(row['sessions'])) as unknown[];
    expect(sessions).toEqual([{ week: 'W1', ageGroup: '6-8', capacity: 3, firstChoice: 8, totalRanked: 8, demandPerSeat: 2.667 }]);
  });

  it('contains no private identifiers or submission times', async () => {
    const row = await db.getRow('odds_snapshots', oddsRowId(programId));
    const text = JSON.stringify(row);
    const apps = await db.listRows('applications', [Query.equal('program_id', programId)]);
    for (const a of apps.rows) {
      expect(text).not.toContain(a.public_id);
      expect(text).not.toContain(a.family_id);
      expect(text).not.toContain(a.submitted_at ?? '__none__');
    }
    expect(text).not.toMatch(/child-|fam-odds|submitted_at/);
  });

  it('changing submission times does not change the estimate within a tier', async () => {
    const before = await tiersOf();
    const apps = await db.listRows('applications', [Query.equal('program_id', programId)]);
    for (const [i, a] of apps.rows.entries()) await db.updateRow('applications', a.$id, { submitted_at: new Date(NOW.getTime() - (apps.total - i) * 3600_000).toISOString() });
    await runOddsForProgram(db, await db.getRow('programs', programId), NOW);
    expect(await tiersOf()).toEqual(before);
  });

  it('freezes 24 hours before close: marked frozen, never recomputed', async () => {
    const program = await db.getRow('programs', programId);
    const inFreeze = new Date(new Date(program.window_close).getTime() - 12 * 3600_000);
    const before = await db.getRow('odds_snapshots', oddsRowId(programId));
    await expect(runOddsForProgram(db, program, inFreeze)).resolves.toEqual({ status: 'frozen' });
    const after = await db.getRow('odds_snapshots', oddsRowId(programId));
    expect(after.frozen).toBe(true);
    expect(after.computed_at).toBe(before.computed_at);
    expect(after.tiers).toBe(before.tiers);
    await expect(runOddsForProgram(db, program, inFreeze)).resolves.toEqual({ status: 'frozen' });
  });
});

describe('jobs Function (deployed)', () => {
  it('runs on a 60-minute interval, the Free plan minimum (no cron on Free)', async () => {
    const fn = await new Functions(aw.client).get({ functionId: 'jobs' });
    expect(fn.interval).toBe(60);
  });

  it('refuses manual runs from non-organisers', async () => {
    const family = await createSyntheticUser('oddsFam');
    try {
      const ex = await new BrowserFunctions(family.client).createExecution({ functionId: 'jobs', body: JSON.stringify({ job: 'odds', programId }), async: false, method: ExecutionMethod.POST });
      expect(ex.responseStatusCode).toBe(403);
    } finally {
      await family.remove();
    }
  });
});
