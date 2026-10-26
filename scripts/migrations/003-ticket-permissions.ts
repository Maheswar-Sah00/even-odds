/**
 * Migration 003: tickets readable by the household only (Task 14 least privilege).
 *
 *   npm run db:migrate:003            dry run: report what would change
 *   npm run db:migrate:003 -- --apply perform it
 *
 * Tickets carry child_key, and organisers who could read every key could
 * confirm guessed identities. New tickets no longer grant the organiser team
 * read access (functions/shared/household.ts); this removes the team grant
 * from tickets created earlier in PRODUCTION programs. Demo sandbox tickets
 * keep their sandbox-team grant (the visitor's own synthetic data).
 * Idempotent: a rerun finds nothing to change.
 */
import { Query } from 'node-appwrite';
import { createServerAppwrite } from '../../functions/shared/appwrite-server.ts';
import { createServerDb } from '../../functions/shared/db.ts';
import { allRows } from '../../functions/shared/household.ts';
import { isDemo } from '../../functions/shared/namespace.ts';
import { formatEnvIssues, loadServerEnv } from '../../functions/shared/server-env.ts';

const apply = process.argv.includes('--apply');
const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const db = createServerDb(createServerAppwrite(env.config, { sink: null }));

const tickets = await allRows(db, 'tickets', [Query.orderAsc('$id')]);
const programs = new Map<string, boolean>();
let changed = 0;
let skippedDemo = 0;
for (const t of tickets) {
  const teamGrants = t.$permissions.filter((p) => p.includes('"team:'));
  if (teamGrants.length === 0) continue;
  if (!programs.has(t.program_id)) programs.set(t.program_id, await db.getRow('programs', t.program_id).then(isDemo, () => false));
  if (programs.get(t.program_id)) {
    skippedDemo++;
    continue;
  }
  changed++;
  console.log(`${apply ? 'Fixing' : 'Would fix'} ${t.$id} (program ${t.program_id}): drop ${teamGrants.join(', ')}`);
  if (apply) await db.updateRow('tickets', t.$id, {}, { permissions: t.$permissions.filter((p) => !teamGrants.includes(p)) });
}
console.log(`${String(tickets.length)} tickets; ${String(changed)} ${apply ? 'fixed' : 'to fix'}; ${String(skippedDemo)} demo-sandbox tickets left as they are.`);
if (!apply && changed > 0) console.log('Dry run. Re-run with -- --apply to change them.');
