import { offersRequestSchema } from '../../../../shared/offer-input.ts';
import { AppError } from '../../../shared/app-error.ts';
import { cancelOffersLogged } from '../../../shared/console.ts';
import { createServerDb } from '../../../shared/db.ts';
import { requireEnv, requireUser, type HandlerInput } from '../../../shared/function-runtime.ts';
import { assertProduction } from '../../../shared/namespace.ts';
import { familyOffers, organiserOffersOverview, processOffers, respondToOffers } from '../../../shared/offer-actions.ts';
import { requireOrganiser } from '../../../shared/organiser.ts';
import { consumeRateLimit } from '../../../shared/rate-limit.ts';

/**
 * Offers area of the api Function. Families act on their own offers (the
 * household is derived from the platform-set user ID, never from the body);
 * organiser actions re-check Team membership and program ownership.
 */
export async function handleOffers({ userId, body, aw }: HandlerInput): Promise<unknown> {
  const caller = requireUser(userId);
  const request = offersRequestSchema.parse(body);
  const db = createServerDb(aw);
  switch (request.action) {
    case 'mine':
      return familyOffers(db, caller, request.programId);
    case 'respond':
      await consumeRateLimit(db, 'offers', caller);
      return respondToOffers(db, caller, request);
    case 'overview':
    case 'cancel':
    case 'process': {
      const teamId = requireEnv('APPWRITE_ORGANISER_TEAM_ID');
      await requireOrganiser(aw.teams, teamId, caller);
      const program = await db.getRow('programs', request.programId).catch(() => null);
      if (!program || program.org_team_id !== teamId) throw new AppError('not_found', 'Program not found.');
      assertProduction(program);
      if (request.action === 'overview') return organiserOffersOverview(db, program);
      if (request.action === 'cancel') return cancelOffersLogged(db, { program, actorId: caller, teamId, scope: 'production', users: aw.users }, request.placementIds, request.idempotencyKey);
      return processOffers(db, program.$id);
    }
  }
}
