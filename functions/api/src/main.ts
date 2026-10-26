import { z } from 'zod';
import { runFunction, type FunctionContext } from '../../shared/function-runtime.ts';
import { handleConsole } from './handlers/console.ts';
import { handleDemo } from './handlers/demo.ts';
import { handleHousehold } from './handlers/household.ts';
import { handleOffers } from './handlers/offers.ts';
import { handleOrganiser } from './handlers/organiser.ts';

/**
 * api Function: every signed-in request, routed by `area`. One Function
 * (instead of one per area) because the Free plan allows only 2 Functions per
 * project (verified: a third returns 403 additional_resource_not_allowed).
 */
const AREAS = { household: handleHousehold, organiser: handleOrganiser, offers: handleOffers, console: handleConsole, demo: handleDemo } as const;
const envelope = z.looseObject({ area: z.enum(['household', 'organiser', 'offers', 'console', 'demo']) });

export default (ctx: FunctionContext) =>
  runFunction(ctx, async (input) => {
    const { area } = envelope.parse(input.body);
    return AREAS[area](input);
  });
