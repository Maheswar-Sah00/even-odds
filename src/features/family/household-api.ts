import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { callFunction } from '../../lib/appwrite/functions.ts';
import type { ChildInput } from '@shared/household-input.ts';
import type { SubmitApplicationInput } from '@shared/application-input.ts';
import type { LngLat } from '@shared/geo.ts';

/** Typed wrappers for the household Function. All checks happen server-side. */
export interface HouseholdSummary {
  familyId: string;
  role: 'primary' | 'linked';
  guardians: { userId: string; role: 'primary' | 'linked'; email: string; isYou: boolean }[];
  pendingInvites: number;
}

export type RegisterTicketResult = { status: 'registered' | 'already_registered'; ticketId: string } | { status: 'possible_duplicate' };

export interface SubmitResult {
  status: 'submitted' | 'updated' | 'replayed';
  applicationId: string;
  publicId: string;
  claimedTier: number;
  nearBoundary: boolean;
  late: boolean;
}

export const householdApi = (app: BrowserAppwrite) => ({
  setHome: (home: LngLat) => callFunction<{ saved: true }>(app, 'household', { action: 'setHome', home }),
  classifyMyHome: (programId: string) => callFunction<{ tier: number; tierLabel: string; nearBoundary: boolean } | null>(app, 'household', { action: 'classifyMyHome', programId }),
  submitApplication: (application: SubmitApplicationInput) => callFunction<SubmitResult>(app, 'household', { action: 'submitApplication', application }),
  withdrawApplication: (programId: string) => callFunction<{ status: 'withdrawn' }>(app, 'household', { action: 'withdrawApplication', programId }),
  get: () => callFunction<HouseholdSummary | null>(app, 'household', { action: 'get' }),
  create: () => callFunction<{ familyId: string; created: boolean }>(app, 'household', { action: 'createHousehold' }),
  addChild: (child: ChildInput) => callFunction<{ $id: string }>(app, 'household', { action: 'addChild', child }),
  updateChild: (childId: string, child: ChildInput) => callFunction<{ $id: string }>(app, 'household', { action: 'updateChild', childId, child }),
  createInvite: () => callFunction<{ code: string; expiresAt: string }>(app, 'household', { action: 'createInvite' }),
  acceptInvite: (code: string) => callFunction<{ familyId: string }>(app, 'household', { action: 'acceptInvite', code }),
  registerTicket: (programId: string, childId: string) => callFunction<RegisterTicketResult>(app, 'household', { action: 'registerTicket', programId, childId }),
  dismissLinkRequest: (linkRequestId: string) => callFunction<{ dismissed: true }>(app, 'household', { action: 'dismissLinkRequest', linkRequestId }),
});
