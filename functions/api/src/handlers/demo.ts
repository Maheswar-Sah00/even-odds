import { demoRequestSchema } from '../../../../shared/demo-input.ts';
import { runConsoleCommand } from '../../../shared/console.ts';
import { createServerDb } from '../../../shared/db.ts';
import { requireEnv, requireUser, type HandlerInput } from '../../../shared/function-runtime.ts';
import {
  closeApplications,
  duplicateChildDemo,
  expireSandboxOffers,
  resetSandbox,
  respondAsSynthetic,
  rollbackDemo,
  runSandboxDraw,
  sandboxActor,
  sandboxStatus,
  type SandboxCaller,
} from '../../../shared/sandbox.ts';

/**
 * Demo area of the api Function: the judge sandbox. Any signed-in user
 * (usually an anonymous session) gets their OWN sandbox. No request names a
 * program; every action resolves the caller's sandbox from the platform-set
 * user ID and re-checks it is that caller's demo program (sandbox.ts,
 * namespace.ts), so nothing here can reach production data.
 */
export async function handleDemo({ userId, clientIp, body, aw }: HandlerInput): Promise<unknown> {
  const request = demoRequestSchema.parse(body);
  const caller: SandboxCaller = { aw, db: createServerDb(aw), ownerId: requireUser(userId), secret: requireEnv('CHILD_KEY_SECRET'), clientIp };
  switch (request.action) {
    case 'status':
      return sandboxStatus(caller);
    case 'reset':
      return resetSandbox(caller, request.idempotencyKey);
    case 'closeApplications':
      return closeApplications(caller);
    case 'runDraw':
      return runSandboxDraw(caller);
    case 'expireOffers':
      return expireSandboxOffers(caller);
    case 'respondAs':
      return respondAsSynthetic(caller, request);
    case 'duplicateChild':
      return duplicateChildDemo(caller);
    case 'rollback':
      return rollbackDemo(caller);
    case 'console':
      return runConsoleCommand(caller.db, await sandboxActor(caller), request.command);
  }
}
