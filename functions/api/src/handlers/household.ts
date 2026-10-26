import { ID } from 'node-appwrite';
import { householdRequestSchema, type HouseholdRequest } from '../../../../shared/household-input.ts';
import { AppError } from '../../../shared/app-error.ts';
import { submitApplication, withdrawApplication } from '../../../shared/applications.ts';
import type { ServerAppwrite } from '../../../shared/appwrite-server.ts';
import { createServerDb } from '../../../shared/db.ts';
import { requireEnv, requireUser, type HandlerInput } from '../../../shared/function-runtime.ts';
import {
  acceptInvite,
  addChild,
  classifyMyHome,
  createHousehold,
  createInvite,
  dismissLinkRequest,
  getHousehold,
  registerTicket,
  setHome,
  updateChild,
} from '../../../shared/household.ts';
import { consumeRateLimit, type RateBucket } from '../../../shared/rate-limit.ts';

/** Writes that are limited per caller (Task 14). Reads and dismissals are not. */
const BUCKET: Partial<Record<HouseholdRequest['action'], RateBucket>> = {
  createHousehold: 'household',
  setHome: 'household',
  addChild: 'identity',
  updateChild: 'identity',
  registerTicket: 'identity',
  createInvite: 'invite',
  acceptInvite: 'invite',
  submitApplication: 'application',
  withdrawApplication: 'application',
};

/**
 * Households take part in real lotteries, so they need a real (email) account:
 * anonymous guest sessions exist only for the judge demo and are refused here.
 */
export async function requireAccount(aw: ServerAppwrite, userId: string): Promise<void> {
  const user = await aw.users.get({ userId });
  if (!user.email) throw new AppError('forbidden', 'Please sign in with your email address to manage a household.');
}

/**
 * Household area of the api Function: every privileged household and
 * application write goes through here. The caller (platform-set user ID) is
 * re-checked by each action.
 */
export async function handleHousehold({ userId, body, aw }: HandlerInput): Promise<unknown> {
  const caller = requireUser(userId);
  const request = householdRequestSchema.parse(body);
  const db = createServerDb(aw);
  const bucket = BUCKET[request.action];
  if (bucket) {
    await requireAccount(aw, caller);
    await consumeRateLimit(db, bucket, caller);
  }
  switch (request.action) {
    case 'get':
      return getHousehold(db, aw.users, caller);
    case 'createHousehold':
      return createHousehold(db, caller);
    case 'addChild':
      return addChild(db, caller, request.child, () => ID.unique());
    case 'updateChild':
      return updateChild(db, requireEnv('CHILD_KEY_SECRET'), caller, request.childId, request.child);
    case 'createInvite':
      return createInvite(db, caller, () => ID.unique());
    case 'acceptInvite':
      return acceptInvite(db, caller, request.code);
    case 'registerTicket':
      return registerTicket(db, requireEnv('CHILD_KEY_SECRET'), caller, request.programId, request.childId);
    case 'dismissLinkRequest':
      await dismissLinkRequest(db, caller, request.linkRequestId);
      return { dismissed: true };
    case 'setHome':
      await setHome(db, caller, request.home);
      return { saved: true };
    case 'classifyMyHome':
      return classifyMyHome(db, caller, request.programId);
    case 'submitApplication':
      return submitApplication(db, requireEnv('CHILD_KEY_SECRET'), caller, request.application);
    case 'withdrawApplication':
      return withdrawApplication(db, caller, request.programId);
  }
}
