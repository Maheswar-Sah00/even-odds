/** npm run odds:run [programId...]: runs the odds job locally with the server key (same code as the Function). */
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { createServerDb } from '../functions/shared/db.ts';
import { runOddsJob } from '../functions/shared/odds-job.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const ids = process.argv.slice(2);
console.log(await runOddsJob(createServerDb(createServerAppwrite(env.config, { sink: null })), new Date(), ids.length ? ids : undefined));
