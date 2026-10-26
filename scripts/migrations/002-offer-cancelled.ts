/**
 * Migration 002: add "cancelled" to placements.status (Task 11 offer lifecycle).
 *
 *   npm run db:migrate:002            dry run: report what would change
 *   npm run db:migrate:002 -- --apply perform it, then run `npm run db:provision`
 *
 * Adding an enum element is data-safe (every existing value stays valid), but
 * the provisioner never alters existing columns, so it is done here explicitly.
 * The element list is taken from shared/schema.ts and must be a superset of
 * the current one; anything else aborts without changes.
 */
import { createServerAppwrite } from '../../functions/shared/appwrite-server.ts';
import { formatEnvIssues, loadServerEnv } from '../../functions/shared/server-env.ts';
import { SCHEMA } from '../../shared/schema.ts';

const apply = process.argv.includes('--apply');
const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const aw = createServerAppwrite(env.config, { sink: null });
const { tablesDB, databaseId } = aw;
const tableId = aw.tables.placements;
const wanted = [...SCHEMA.placements.columns.status.elements];

const column = (await tablesDB.getColumn({ databaseId, tableId, key: 'status' })) as { elements?: string[]; required: boolean };
const current = column.elements ?? [];
console.log(`${tableId}.status elements: [${current.join(', ')}]`);
const removed = current.filter((e) => !wanted.includes(e as never));
if (removed.length > 0) {
  console.error(`ABORTED: the schema would remove [${removed.join(', ')}], which existing rows may use.`);
  process.exit(1);
}
const added = wanted.filter((e) => !current.includes(e));
if (added.length === 0) {
  console.log('Nothing to do: already up to date.');
  process.exit(0);
}
console.log(`${apply ? 'Adding' : 'Would add'}: [${added.join(', ')}]`);
if (!apply) {
  console.log('Dry run. Re-run with -- --apply to change the column.');
  process.exit(0);
}
await tablesDB.updateEnumColumn({ databaseId, tableId, key: 'status', elements: wanted, required: column.required, xdefault: null });
console.log('Done. Now run `npm run db:provision` to add the Task 11 columns.');
