import { z } from 'zod';
import { idempotencyKeySchema } from './offer-input.ts';
import { OVERRIDE_REASONS } from './schema.ts';

/**
 * Organiser console commands (Task 12), shared by the browser and the server
 * (authoritative). The same commands run against a production program
 * (api area "console", organiser Team required) and against the caller's own
 * demo sandbox (api area "demo", action "console"); only the authorisation
 * differs, never the code that does the work.
 *
 * Families are identified by their pseudonymous public ID (the receipt code);
 * reasons are fixed codes, never free text, so nothing here can carry PII.
 */

const id36 = z.string().min(1).max(36);
const publicId = z.string().regex(/^[0-9a-f]{32}$/, 'Use the 32-character receipt code');

export const OVERRIDE_POOLS = ['general', 'accommodation'] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

export const OVERRIDE_REASON_TEXT: Readonly<Record<OverrideReason, string>> = {
  accommodation: 'Accommodation (an aide, medical or access need)',
  sibling_enrolled: 'Sibling already enrolled in the program',
  staff_family: 'Child of program staff',
  policy_exception: 'Policy exception approved by the program board',
};

export const VERIFICATION_REASONS = ['residency_confirmed', 'proof_not_provided', 'address_outside_zone', 'boundary_reviewed'] as const;
export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

export const VERIFICATION_REASON_TEXT: Readonly<Record<VerificationReason, string>> = {
  residency_confirmed: 'Residency proof checked: claimed tier confirmed',
  proof_not_provided: 'No proof of residency provided',
  address_outside_zone: 'Proof shows an address outside the claimed zone',
  boundary_reviewed: 'Near a zone edge: reviewed against the official boundary',
};

export const consoleCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('demand') }),
  z.object({ action: z.literal('verificationQueue') }),
  z.object({ action: z.literal('verifyTier'), publicId, tier: z.number().int().min(0).max(9), reasonCode: z.enum(VERIFICATION_REASONS), idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('overrides') }),
  z.object({ action: z.literal('createOverride'), publicId, reasonCode: z.enum(OVERRIDE_REASONS), pool: z.enum(OVERRIDE_POOLS), idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('removeOverride'), publicId, idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('staffLog') }),
  z.object({ action: z.literal('fairness') }),
  z.object({ action: z.literal('drawStatus') }),
  z.object({ action: z.literal('setCapacity'), ledgerId: id36, capacity: z.number().int() }),
  z.object({ action: z.literal('offersOverview') }),
  z.object({ action: z.literal('cancelOffers'), placementIds: z.array(id36).min(1).max(12), idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('processOffers') }),
]);

export type ConsoleCommand = z.input<typeof consoleCommandSchema>;
export type ConsoleAction = ConsoleCommand['action'];

/** Production console: `{ area: "console", programId, command }`. */
export const consoleRequestSchema = z.object({ programId: id36, command: consoleCommandSchema });
