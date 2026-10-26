/**
 * Migration 001: split households from per-program applications.
 *
 *   npm run db:migrate:001            dry run: report what would change
 *   npm run db:migrate:001 -- --apply perform it, then run `npm run db:provision`
 *
 * Changes (see docs/MIGRATIONS.md):
 * - families, family_locations, guardians, children: columns changed incompatibly.
 *   These tables are DELETED and recreated by the provisioner, but ONLY if they
 *   contain zero rows. If any has data, the migration aborts without changes.
 * - placements: unique index uq_child_week -> uq_program_child_week.
 * - preferences: unique index uq_child -> uq_program_child.
 *   Old indexes are deleted (no data is touched); the provisioner adds the new ones.
 */
import { createServerAppwrite } from '../../functions/shared/appwrite-server.ts';
import { formatEnvIssues, loadServerEnv } from '../../functions/shared/server-env.ts';

const apply = process.argv.includes('--apply');
const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const aw = createServerAppwrite(env.config, { sink: null });
const { tablesDB, databaseId } = aw;

const RECREATE = ['families', 'family_locations', 'guardians', 'children'] as const;
const DROP_INDEXES = [
  { table: 'placements', key: 'uq_child_week' },
  { table: 'preferences', key: 'uq_child' },
] as const;

const exists = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return false;
    throw err;
  }
};

// 1. Safety check: every table to be recreated must be empty.
const blockers: string[] = [];
for (const table of [...RECREATE, ...DROP_INDEXES.map((d) => d.table)]) {
  const tableId = aw.tables[table];
  if (!(await exists(() => tablesDB.getTable({ databaseId, tableId })))) continue;
  const { total } = await tablesDB.listRows({ databaseId, tableId, queries: [], total: true });
  console.log(`${tableId}: ${total} row(s)`);
  if (total > 0 && (RECREATE as readonly string[]).includes(table)) blockers.push(`${tableId} has ${total} row(s)`);
}
if (blockers.length > 0) {
  console.error(`ABORTED: refusing to delete tables that contain data:\n  ${blockers.join('\n  ')}\nMigrate the data manually first.`);
  process.exit(1);
}

// 2. Plan / apply.
for (const table of RECREATE) {
  const tableId = aw.tables[table];
  if (!(await exists(() => tablesDB.getTable({ databaseId, tableId })))) {
    console.log(`- ${tableId}: already absent`);
    continue;
  }
  console.log(`- ${apply ? 'deleting' : 'would delete'} empty table ${tableId}`);
  if (apply) await tablesDB.deleteTable({ databaseId, tableId });
}
for (const { table, key } of DROP_INDEXES) {
  const tableId = aw.tables[table];
  if (!(await exists(() => tablesDB.getIndex({ databaseId, tableId, key })))) {
    console.log(`- ${tableId}.${key}: already absent`);
    continue;
  }
  console.log(`- ${apply ? 'deleting' : 'would delete'} index ${tableId}.${key}`);
  if (apply) await tablesDB.deleteIndex({ databaseId, tableId, key });
}
console.log(apply ? 'Done. Now run: npm run db:provision' : 'Dry run only. Re-run with --apply to perform these changes.');
