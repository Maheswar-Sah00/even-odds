import { z } from 'zod';
import { SIBLING_MODES } from './schema.ts';

/**
 * The application submission. STRICT objects: unknown fields (for example a
 * client-supplied "claimed_tier" or "verified_tier") are rejected, not ignored.
 * Tiers, eligibility, submission time and public IDs are computed server-side.
 */
const weekCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/, 'Unknown week');

export const applicationChildSchema = z.strictObject({
  childId: z.string().min(1).max(36),
  rankedWeeks: z
    .array(weekCode)
    .min(1, 'Choose at least one week for each child')
    .max(12)
    .refine((w) => new Set(w).size === w.length, 'A week can only be ranked once'),
  requestedWeeks: z.number().int().min(1, 'Ask for at least one week').max(12),
});

export const submitApplicationSchema = z.strictObject({
  programId: z.string().min(1).max(36),
  siblingMode: z.enum(SIBLING_MODES),
  children: z
    .array(applicationChildSchema)
    .min(1, 'Include at least one child')
    .max(12)
    .refine((c) => new Set(c.map((x) => x.childId)).size === c.length, 'Each child can only be included once'),
  /** Client-generated per wizard session; the same key always returns the same result. */
  idempotencyKey: z.string().min(16).max(128),
});

export type SubmitApplicationInput = z.infer<typeof submitApplicationSchema>;
