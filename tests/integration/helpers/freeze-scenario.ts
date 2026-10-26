/**
 * Synthetic program scenarios for the freeze protocol tests (real TablesDB).
 *
 * `past: true` moves a program into the past with the server key (TEST-ONLY
 * setup, labelled): window_close is set so that the announcement rule gives
 * quicknet round 1,000,000 (published 2023-09-27), so its beacon already
 * exists. The protocol code itself never writes these fields after publish.
 */
import { Query } from 'node-appwrite';
import { applicationRowId, preferenceRowId } from '../../../functions/shared/applications.ts';
import { newPublicId } from '../../../functions/shared/crypto.ts';
import { ticketRowId } from '../../../functions/shared/household.ts';
import { createProgram, publishProgram, replaceSessions } from '../../../functions/shared/organiser.ts';
import type { TableKey } from '../../../shared/config.ts';
import { announcedRound, ROUND_DELAY_MS, roundTimeMs } from '../../../shared/freeze/drand.ts';
import { parseSessionsCsv, programDetailsSchema } from '../../../shared/program-input.ts';
import { db, RUN_ID, serverEnv } from './server.ts';

export const teamId = serverEnv.organiserTeamId ?? 'organisers';
const programs: string[] = [];
export const PAST_ROUND = 1_000_000;
const PAST_CLOSE = new Date(roundTimeMs(PAST_ROUND) - ROUND_DELAY_MS).toISOString();
const CSV = 'week,week_start,age_group,min_age,max_age,capacity\nW1,2027-06-21,young,5,7,3\nW1,2027-06-21,old,8,10,2\nW2,2027-06-28,young,5,7,2\nW2,2027-06-28,old,8,10,2\n';

export async function scenario(name: string, opts: { families?: number; past?: boolean; prefix?: string } = {}) {
  const programId = `${opts.prefix ?? 'itf'}-${name}-${RUN_ID}`.slice(0, 36);
  programs.push(programId);
  const now = Date.now();
  await createProgram(
    db,
    teamId,
    programDetailsSchema.parse({ name: `[SYNTHETIC] freeze ${name} ${RUN_ID}`, timezone: 'UTC', windowOpen: new Date(now - 7200_000).toISOString(), windowClose: new Date(now + 2 * 86400_000).toISOString(), maxWeeks: 2, defaultTier: 1, tierLabels: { '0': 'A', '1': 'B' } }),
    { programId, synthetic: true },
  );
  await replaceSessions(db, teamId, programId, parseSessionsCsv(CSV).sessions);
  await publishProgram(db, teamId, programId);
  const families = opts.families ?? 6;
  for (let i = 0; i < families; i++) {
    const familyId = `ff-${name}-${String(i)}-${RUN_ID}`.slice(0, 36);
    const kids = i % 3 === 0 ? 2 : 1;
    await db.createRow('applications', applicationRowId(programId, familyId), {
      program_id: programId, family_id: familyId, public_id: newPublicId(), status: 'submitted', claimed_tier: i % 4 === 0 ? 0 : 1, synthetic: true,
      sibling_mode: kids > 1 ? (['together_only', 'together_preferred'] as const)[i % 2] ?? 'independent' : 'independent',
    });
    for (let k = 0; k < kids; k++) {
      const childId = `cf-${name}-${String(i)}-${String(k)}-${RUN_ID}`.slice(0, 36);
      const group = (i + k) % 2 === 0 ? 'young' : 'old';
      await db.createRow('tickets', ticketRowId(programId, childId), { program_id: programId, child_id: childId, family_id: familyId, child_key: newPublicId() + newPublicId() });
      await db.createRow('preferences', preferenceRowId(programId, childId), {
        program_id: programId, family_id: familyId, child_id: childId, ranked_weeks: i % 2 ? ['W1', 'W2'] : ['W2', 'W1'], ranked_age_groups: [group, group], requested_weeks: 1 + (i % 2),
      });
    }
  }
  if (opts.past) {
    await db.updateRow('programs', programId, { window_open: '2023-09-01T00:00:00.000Z', window_close: PAST_CLOSE, drand_round: announcedRound(PAST_CLOSE) });
  }
  const program = await db.getRow('programs', programId);
  return { programId, program, afterClose: new Date(Date.parse(program.window_close) + 60_000) };
}

export const auditOf = async (programId: string) => (await db.listRows('audit_log', [Query.equal('program_id', programId), Query.orderAsc('seq'), Query.limit(100)])).rows;
export const runsOf = async (programId: string) => (await db.listRows('draw_runs', [Query.equal('program_id', programId), Query.limit(100)])).rows;
export const snapshotsOf = async (programId: string) => (await db.listRows('frozen_inputs', [Query.equal('program_id', programId), Query.limit(100)])).rows;

/** Deletes every row of every program created through scenario(). Call from afterAll. */
export async function cleanupScenarios(): Promise<void> {
  const tables: TableKey[] = ['placements', 'waitlist', 'idempotency', 'preferences', 'tickets', 'applications', 'seat_ledger', 'audit_log', 'draw_runs', 'frozen_inputs', 'draw_results'];
  for (const programId of programs) {
    for (const t of tables) {
      for (;;) {
        const { rows } = await db.listRows(t, [Query.equal('program_id', programId), Query.limit(100)]);
        if (rows.length === 0) break;
        await Promise.all(rows.map((r) => db.deleteRow(t, r.$id)));
      }
    }
    await db.deleteRow('programs', programId).catch(() => undefined);
  }
}
