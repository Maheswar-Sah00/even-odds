/**
 * npm run setup:organisers [-- --add-email you@example.com]
 * Ensures the organiser Team exists (ID from APPWRITE_ORGANISER_TEAM_ID,
 * default "organisers") and optionally adds an existing user to it. The user
 * must have signed in at least once so the account exists.
 */
import { ID, Query } from 'node-appwrite';
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const aw = createServerAppwrite(env.config, { sink: null });
const teamId = env.config.organiserTeamId ?? 'organisers';

try {
  await aw.teams.get({ teamId });
  console.log(`Team "${teamId}" exists.`);
} catch (err) {
  if ((err as { code?: number }).code !== 404) throw err;
  await aw.teams.create({ teamId, name: 'Even Odds organisers' });
  console.log(`Created team "${teamId}".`);
}

const emailArg = process.argv.indexOf('--add-email');
const email = emailArg > -1 ? process.argv[emailArg + 1] : undefined;
if (email) {
  const { users } = await aw.users.list({ queries: [Query.equal('email', email), Query.limit(1)] });
  const user = users[0];
  if (!user) {
    console.error(`No account for ${email}. Sign in once at /signin, then rerun.`);
    process.exit(1);
  }
  const { memberships } = await aw.teams.listMemberships({ teamId, queries: [Query.equal('userId', user.$id)] });
  if (memberships.length > 0) console.log(`${email} is already an organiser.`);
  else {
    await aw.teams.createMembership({ teamId, roles: ['organiser'], userId: user.$id, membershipId: ID.unique() });
    console.log(`Added ${email} to "${teamId}".`);
  }
}
console.log(`Set APPWRITE_ORGANISER_TEAM_ID=${teamId} in .env.server and VITE_APPWRITE_ORGANISER_TEAM_ID=${teamId} in .env.local.`);
