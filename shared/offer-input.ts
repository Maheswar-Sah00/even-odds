import { z } from 'zod';

/**
 * Requests to the offers area of the api Function, shared by the browser and
 * the server (authoritative). Placement IDs and idempotency keys are the only
 * client-supplied values; ownership, state and expiry are decided server-side.
 */
const id36 = z.string().min(1).max(36);

/** A fresh random key per user intent (e.g. crypto.randomUUID()), reused on every retry of that intent. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'The request key must be 16-64 letters, digits, "-" or "_"');

export const OFFER_RESPONSES = ['accept', 'decline', 'giveBack'] as const;
export type OfferResponse = (typeof OFFER_RESPONSES)[number];

export const offersRequestSchema = z.discriminatedUnion('action', [
  // Families
  z.object({ action: z.literal('mine'), programId: id36.optional() }),
  z.object({
    action: z.literal('respond'),
    programId: id36,
    placementIds: z.array(id36).min(1).max(12),
    response: z.enum(OFFER_RESPONSES),
    idempotencyKey: idempotencyKeySchema,
  }),
  // Organisers (Team membership re-checked server-side)
  z.object({ action: z.literal('overview'), programId: id36 }),
  z.object({ action: z.literal('cancel'), programId: id36, placementIds: z.array(id36).min(1).max(12), idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('process'), programId: id36 }),
]);

export type OffersRequest = z.input<typeof offersRequestSchema>;
export const ORGANISER_OFFER_ACTIONS = ['overview', 'cancel', 'process'] as const;
