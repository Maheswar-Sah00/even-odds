import { z } from 'zod';
import { submitApplicationSchema } from './application-input.ts';
import { normaliseName } from './identity.ts';

/**
 * Validation shared by the browser forms (instant feedback) and the household
 * Function (authoritative). The server never trusts that the client ran it.
 */
const name = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(64, `${label} must be 64 characters or fewer`)
    .refine((v) => normaliseName(v).length > 0, `${label} must contain letters`);

export const childInputSchema = z.object({
  firstName: name('First name'),
  lastName: name('Last name'),
  birthdate: z
    .string({ error: 'Date of birth is required' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth as YYYY-MM-DD')
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    }, 'Enter a real date')
    .refine((v) => new Date(`${v}T00:00:00Z`) <= new Date(), 'Date of birth cannot be in the future')
    .refine((v) => new Date(`${v}T00:00:00Z`) >= new Date(Date.UTC(new Date().getUTCFullYear() - 25, 0, 1)), 'Children must be under 25'),
});

export type ChildInput = z.infer<typeof childInputSchema>;

/** Invite codes: 10 characters from an unambiguous alphabet, shown as XXXXX-XXXXX. */
export const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const inviteCodeSchema = z
  .string({ error: 'Enter the invite code' })
  .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  .refine((v) => new RegExp(`^[${INVITE_ALPHABET}]{10}$`).test(v), 'Invite codes are 10 letters and numbers, like ABCDE-23456');

export const formatInviteCode = (raw: string) => `${raw.slice(0, 5)}-${raw.slice(5)}`;

export const householdRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }),
  z.object({ action: z.literal('createHousehold') }),
  z.object({ action: z.literal('addChild'), child: childInputSchema }),
  z.object({ action: z.literal('updateChild'), childId: z.string().min(1).max(36), child: childInputSchema }),
  z.object({ action: z.literal('createInvite') }),
  z.object({ action: z.literal('acceptInvite'), code: inviteCodeSchema }),
  z.object({ action: z.literal('registerTicket'), programId: z.string().min(1).max(36), childId: z.string().min(1).max(36) }),
  z.object({ action: z.literal('dismissLinkRequest'), linkRequestId: z.string().min(1).max(36) }),
  z.object({ action: z.literal('setHome'), home: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
  z.object({ action: z.literal('classifyMyHome'), programId: z.string().min(1).max(36) }),
  z.object({ action: z.literal('submitApplication'), application: submitApplicationSchema }),
  z.object({ action: z.literal('withdrawApplication'), programId: z.string().min(1).max(36) }),
]);

export type HouseholdRequest = z.input<typeof householdRequestSchema>;
