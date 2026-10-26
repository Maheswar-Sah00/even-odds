/**
 * npm run seed:demo
 * Creates and publishes the SYNTHETIC demo program "Riverside Parks Summer
 * Camp 2027" through the same organiser service the Function uses
 * (validation, deterministic IDs, publish checks, audit entry).
 * Idempotent: an already-published demo is left untouched.
 */
import { readFileSync } from 'node:fs';
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { createServerDb } from '../functions/shared/db.ts';
import { createProgram, publishProgram, replaceSessions, replaceZones, updateProgram } from '../functions/shared/organiser.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';
import { parseSessionsCsv, parseZonesGeoJson, programDetailsSchema } from '../shared/program-input.ts';

export const DEMO_PROGRAM_ID = 'demo-summer-2027';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const teamId = env.config.organiserTeamId;
if (!teamId) {
  console.error('Set APPWRITE_ORGANISER_TEAM_ID (run npm run setup:organisers first).');
  process.exit(2);
}
const db = createServerDb(createServerAppwrite(env.config, { sink: null }));

const now = Date.now();
const details = programDetailsSchema.parse({
  name: '[SYNTHETIC] Riverside Parks Summer Camp 2027',
  description:
    'Six weeks of day camp for ages 5-13 at a fictional parks department. Families who live in the Riverside zones get priority; everyone else is still entered. All data in this demo program is synthetic.',
  timezone: 'America/New_York',
  // Relative window so the demo is always accepting applications when seeded.
  windowOpen: new Date(now - 3600_000).toISOString(),
  windowClose: new Date(now + 21 * 86400_000).toISOString(),
  maxWeeks: 3,
  defaultTier: 2,
  tierLabels: { '0': 'Riverside core residents', '1': 'Greater Riverside residents', '2': 'Everyone else' },
});

const existing = await db.getRow('programs', DEMO_PROGRAM_ID).catch(() => null);
if (existing && existing.status !== 'draft') {
  console.log(`Demo program already published (status ${existing.status}). Nothing to do.`);
  process.exit(0);
}
if (existing) await updateProgram(db, teamId, DEMO_PROGRAM_ID, details);
else
  await createProgram(db, teamId, details, {
    programId: DEMO_PROGRAM_ID,
    synthetic: true,
    sourceNote: 'Synthetic demo catalogue: weeks, ages and capacities are invented; zones are drawn loosely over Fairfax, VA and are not official boundaries.',
  });

const sessions = parseSessionsCsv(readFileSync('data/demo/sessions.csv', 'utf8'));
if (sessions.errors.length) throw new Error(`Demo CSV invalid: ${JSON.stringify(sessions.errors)}`);
console.log('sessions', await replaceSessions(db, teamId, DEMO_PROGRAM_ID, sessions.sessions));

const zones = parseZonesGeoJson(readFileSync('data/demo/zones.geojson', 'utf8'));
if (zones.errors.length) throw new Error(`Demo zones invalid: ${zones.errors.join('; ')}`);
console.log('zones', await replaceZones(db, teamId, DEMO_PROGRAM_ID, zones.zones));

const published = await publishProgram(db, teamId, DEMO_PROGRAM_ID);
console.log(`Published ${published.name} (${published.$id}); applications close ${published.window_close}.`);
