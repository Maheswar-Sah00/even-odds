/**
 * npm run diagnose: server-side connection diagnostics.
 * Validates .env.server, pings the project with the API key, checks the
 * database exists and reports schema drift. Prints no secrets.
 */
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { formatReport, provisionSchema } from '../functions/shared/provisioning.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';
import { ServiceError } from '../shared/errors.ts';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const { config } = env;
console.log(`Endpoint:   ${config.endpoint}`);
console.log(`Project:    ${config.projectId}`);
console.log(`Database:   ${config.databaseId}`);
console.log(`API key:    set (${config.apiKey.length} chars, not shown)`);
console.log(`Child-key secret: ${config.childKeySecret ? 'set' : 'NOT SET (needed for applications)'}`);

const aw = createServerAppwrite(config, { sink: null });
try {
  await aw.log.run('ping', () => aw.client.ping());
  console.log('Ping:       ok');
} catch (err) {
  const e = err as ServiceError;
  console.error(`Ping:       FAILED ${e.mapped.kind} ${e.mapped.type ?? ''} ${e.detail ?? e.message}`);
  process.exit(1);
}

const report = await provisionSchema({ api: aw.tablesDB, log: aw.log, databaseId: aw.databaseId, tables: aw.tables, mode: 'check' });
console.log(formatReport(report));
process.exit(report.inSync ? 0 : 1);
