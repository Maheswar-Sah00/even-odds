/**
 * npm run smoke:demo
 * Calls the DEPLOYED api Function's "demo" area as a fresh synthetic user
 * (same path as the browser: a real session, no API key on the request),
 * walks the whole judge script and prints each step's timing, then removes
 * the user and their sandbox. Use after `npm run functions:deploy`.
 */
import { Client as BrowserClient, ExecutionMethod, Functions } from 'appwrite';
import { ID } from 'node-appwrite';
import { createServerAppwrite } from '../functions/shared/appwrite-server.ts';
import { createServerDb } from '../functions/shared/db.ts';
import { destroySandbox } from '../functions/shared/sandbox.ts';
import { formatEnvIssues, loadServerEnv } from '../functions/shared/server-env.ts';

const env = loadServerEnv();
if (!env.ok) {
  console.error(formatEnvIssues(env.issues));
  process.exit(2);
}
const aw = createServerAppwrite(env.config, { sink: null });
const userId = ID.unique();
await aw.users.create({ userId, name: '[SYNTHETIC] demo smoke test' });
const session = await aw.users.createSession({ userId });
const client = new BrowserClient().setEndpoint(env.config.endpoint).setProject(env.config.projectId).setSession(session.secret);
const functions = new Functions(client);

async function demo(body: Record<string, unknown>) {
  const started = Date.now();
  const ex = await functions.createExecution({ functionId: 'api', body: JSON.stringify({ area: 'demo', ...body }), async: false, method: ExecutionMethod.POST, headers: { 'content-type': 'application/json' } });
  const envelope = JSON.parse(ex.responseBody || '{}') as { ok: boolean; data?: Record<string, unknown>; error?: { message: string } };
  console.log(`${String(body.action).padEnd(18)} ${String(Date.now() - started).padStart(6)} ms  ${envelope.ok ? 'ok' : `ERROR ${envelope.error?.message ?? ex.responseStatusCode}`}`);
  if (!envelope.ok) throw new Error(envelope.error?.message ?? 'failed');
  return envelope.data ?? {};
}

let failed = false;
try {
  await demo({ action: 'status' });
  await demo({ action: 'duplicateChild' });
  await demo({ action: 'closeApplications' });
  for (let i = 0; i < 40; i++) {
    const r = (await demo({ action: 'runDraw' })) as { status: { status: string; offersIssuedAt: string | null } };
    if (r.status.status === 'drawn' && r.status.offersIssuedAt) break;
    await new Promise((res) => setTimeout(res, 4000));
  }
  await demo({ action: 'rollback' });
  const exp = (await demo({ action: 'expireOffers' })) as { sweep: { more: boolean } };
  for (let more = exp.sweep.more, i = 0; more && i < 10; i++) more = ((await demo({ action: 'console', command: { action: 'processOffers' } })) as { more: boolean }).more;
  await demo({ action: 'console', command: { action: 'fairness' } });
  await demo({ action: 'reset', idempotencyKey: `smoke-${ID.unique()}` });
  for (let i = 0; i < 5 && ((await demo({ action: 'status' })) as { cleanupPending: number }).cleanupPending > 0; i++);
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  await destroySandbox(aw, createServerDb(aw), userId).catch(() => undefined);
  await aw.users.delete({ userId }).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
