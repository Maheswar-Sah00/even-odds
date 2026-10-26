import { z } from 'zod';
import { consoleCommandSchema } from './console-input.ts';
import { idempotencyKeySchema, OFFER_RESPONSES } from './offer-input.ts';

/**
 * Requests to the api "demo" area (judge sandbox, Task 12). None of them
 * carries a program ID: the server derives the caller's own sandbox from the
 * session, so a demo request cannot name, read or change any other program.
 */
export const demoRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('reset'), idempotencyKey: idempotencyKeySchema }),
  z.object({ action: z.literal('closeApplications') }),
  z.object({ action: z.literal('runDraw') }),
  z.object({ action: z.literal('expireOffers') }),
  z.object({ action: z.literal('respondAs'), publicId: z.string().regex(/^[0-9a-f]{32}$/), response: z.enum(OFFER_RESPONSES) }),
  z.object({ action: z.literal('duplicateChild') }),
  z.object({ action: z.literal('rollback') }),
  z.object({ action: z.literal('console'), command: consoleCommandSchema }),
]);

export type DemoRequest = z.input<typeof demoRequestSchema>;
