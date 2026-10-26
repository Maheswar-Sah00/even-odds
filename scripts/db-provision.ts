/**
 * npm run db:provision            create missing database/tables/columns/indexes
 * npm run db:check                read-only drift report; exit 1 if not in sync
 * npm run db:provision -- --fix-permissions   also correct table permission drift
 *
 * Never deletes or modifies existing columns, indexes or rows.
 */
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { provisionSchema, formatReport } from '../functions/shared/provisioning.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';

const args = new Set(process.argv.slice(2));
const mode = args.has('--check') ? 'check' : 'apply';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}

const aw = createServerAppwrite(env.config, { sink: args.has('--verbose') ? undefined : null });
console.log(`${mode === 'check' ? 'Checking' : 'Provisioning'} schema on ${env.config.endpoint} (project ${env.config.projectId})…`);

const report = await provisionSchema({
  api: aw.tablesDB,
  log: aw.log,
  databaseId: aw.databaseId,
  tables: aw.tables,
  mode,
  fixPermissions: args.has('--fix-permissions'),
});
console.log(formatReport(report));
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
process.exit(report.inSync ? 0 : 1);
