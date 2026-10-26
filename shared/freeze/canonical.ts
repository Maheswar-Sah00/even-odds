import { z } from 'zod';
import { canonicalJson, DRAW_ALGORITHM, INPUTS_SCHEMA, validateInputs, type DrawInputs } from '../draw/plan.ts';
import { sha256Hex } from '../draw/sha256.ts';
import { SCHEMA, SIBLING_MODES } from '../schema.ts';

/**
 * Canonical serialization of frozen draw inputs (`even-odds-frozen-inputs-v1`),
 * specified in docs/FREEZE-PROTOCOL.md. Pure and isomorphic: the freeze on the
 * server and the verifier in the browser run this same file.
 *
 * - Allow-list, strict: every object has exactly the documented fields, so a
 *   name, birthdate, home, family/user ID or secret cannot ride along. Unknown
 *   fields are an error, never silently dropped.
 * - Fully ordered: sessions by (week, age group), applications and overrides
 *   by public ID, children by ref, all by UTF-16 code unit (JS `<`), the same
 *   comparator the draw module uses. Ranked weeks and their age groups keep
 *   their order: it is the preference.
 * - Integers only (no floats, exponents or -0); booleans are explicit; there
 *   are no dates in the hashed inputs (freeze time is published beside them).
 * - Bytes = UTF-8 of canonicalJson (sorted keys, no whitespace).
 *
 * The hash of these bytes equals the draw module's inputsHash() of the same
 * inputs, so draw_runs.inputs_hash, programs.inputs_hash and the plan agree.
 */

export const FROZEN_FORMAT = 'even-odds-frozen-inputs-v1';
// (The container format is unchanged; the inputs' own `schema` field says draw-inputs-v1 or -v2.)

/** Identifiers: ASCII letters, digits, ".", "_", "-"; no spaces, "@" or other characters that could carry contact details. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ident = (what: string) => z.string().regex(IDENT, `${what} must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" or "-"`);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const REASON_CODES = SCHEMA.overrides.columns.reason_code.elements;
const POOLS = SCHEMA.overrides.columns.pool.elements;

const childSchema = z.strictObject({
  ref: ident('Child ref'),
  rankedWeeks: z.array(ident('Week')).min(1).max(64),
  ageGroups: z.array(ident('Age group')).min(1).max(64),
  requested: int(1, 12),
});

const applicationSchema = z.strictObject({
  publicId: ident('Public ID'),
  tier: int(0, 9),
  late: z.boolean(),
  siblingMode: z.enum(SIBLING_MODES),
  withdrawn: z.boolean().optional(),
  children: z.array(childSchema).min(1).max(20),
});

const common = {
  algorithm: z.literal(DRAW_ALGORITHM),
  programId: ident('Program ID'),
  maxWeeks: int(1, 12),
  sessions: z.array(z.strictObject({ week: ident('Week'), ageGroup: ident('Age group'), capacity: int(0, 100_000) })).min(1),
  applications: z.array(applicationSchema),
};
// v2 (written since Task 14): an override is only a public ID; its reason and pool stay private to staff.
// v1 (earlier freezes) also carried reasonCode and pool; still accepted so those programs verify.
const inputsSchema = z.discriminatedUnion('schema', [
  z.strictObject({ schema: z.literal(INPUTS_SCHEMA), ...common, overrides: z.array(z.strictObject({ publicId: ident('Override public ID') })) }),
  z.strictObject({ schema: z.literal('draw-inputs-v1'), ...common, overrides: z.array(z.strictObject({ publicId: ident('Override public ID'), reasonCode: z.enum(REASON_CODES), pool: z.enum(POOLS) })) }),
]);

export class FrozenInputsError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Frozen inputs are not valid: ${problems.join('; ')}`);
    this.name = 'FrozenInputsError';
    this.problems = problems;
  }
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Validates and returns the canonical form. Throws FrozenInputsError listing every problem. */
export function canonicalFrozenInputs(raw: unknown): DrawInputs {
  const parsed = inputsSchema.safeParse(raw);
  if (!parsed.success) throw new FrozenInputsError(parsed.error.issues.map((i) => `${i.path.join('.') || 'inputs'}: ${i.message}`));
  const p = parsed.data;
  const inputs: DrawInputs = {
    schema: p.schema,
    algorithm: p.algorithm,
    programId: p.programId,
    maxWeeks: p.maxWeeks,
    sessions: p.sessions.map((s) => ({ week: s.week, ageGroup: s.ageGroup, capacity: s.capacity })).sort(byKey((s) => `${s.week}\u0000${s.ageGroup}`)),
    applications: p.applications
      .map((a) => ({
        publicId: a.publicId,
        tier: a.tier,
        late: a.late,
        siblingMode: a.siblingMode,
        // `withdrawn` is present only when true, so "absent" and "false" cannot hash differently.
        ...(a.withdrawn ? { withdrawn: true } : {}),
        children: a.children.map((c) => ({ ref: c.ref, rankedWeeks: [...c.rankedWeeks], ageGroups: [...c.ageGroups], requested: c.requested })).sort(byKey((c) => c.ref)),
      }))
      .sort(byKey((a) => a.publicId)),
    overrides: p.overrides.map((o) => ('reasonCode' in o ? { publicId: o.publicId, reasonCode: o.reasonCode, pool: o.pool } : { publicId: o.publicId })).sort(byKey((o) => o.publicId)),
  };

  const problems = validateInputs(inputs);
  const publicIds = new Set(inputs.applications.map((a) => a.publicId));
  const overridden = new Set<string>();
  for (const o of inputs.overrides) {
    if (overridden.has(o.publicId)) problems.push(`Duplicate override for ${o.publicId}`);
    overridden.add(o.publicId);
    if (!publicIds.has(o.publicId)) problems.push(`Override for ${o.publicId}, which has no application`);
  }
  for (const a of inputs.applications) {
    for (const c of a.children) {
      if (new Set(c.rankedWeeks).size !== c.rankedWeeks.length) problems.push(`Child ${c.ref} ranks a week twice`);
    }
  }
  if (problems.length > 0) throw new FrozenInputsError(problems);
  return inputs;
}

/** The exact text that is hashed and published. */
export const serializeFrozenInputs = (inputs: unknown): string => canonicalJson(canonicalFrozenInputs(inputs));

/** SHA-256 (lowercase hex) of the UTF-8 bytes of a canonical serialization. */
export const frozenInputsHash = (canonical: string): string => sha256Hex(canonical);

/**
 * Parses a published inputs file and proves it is canonical: re-serializing
 * must give back the identical text. Any reordering, extra whitespace or
 * extra field is rejected, so one set of inputs has exactly one hash.
 */
export function parseFrozenInputs(text: string): { inputs: DrawInputs; hash: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FrozenInputsError(['not valid JSON']);
  }
  const canonical = serializeFrozenInputs(raw);
  if (canonical !== text) throw new FrozenInputsError(['not in canonical form (key order, record order, whitespace or optional fields differ)']);
  return { inputs: JSON.parse(canonical) as DrawInputs, hash: frozenInputsHash(canonical) };
}

export interface FrozenSummary {
  applications: number;
  children: number;
  sessions: number;
  seats: number;
  overrides: number;
  /** reason code -> count, keys sorted; categories only. Empty from draw-inputs-v2 on (reasons are not published). */
  overrideCounts: Record<string, number>;
}

/** Public record counts, computed from the canonical inputs (anyone can recompute them). */
export function summarizeFrozenInputs(inputs: DrawInputs): FrozenSummary {
  const counts: Record<string, number> = {};
  for (const o of inputs.overrides) if (o.reasonCode !== undefined) counts[o.reasonCode] = (counts[o.reasonCode] ?? 0) + 1;
  return {
    applications: inputs.applications.length,
    children: inputs.applications.reduce((n, a) => n + a.children.length, 0),
    sessions: inputs.sessions.length,
    seats: inputs.sessions.reduce((n, s) => n + s.capacity, 0),
    overrides: inputs.overrides.length,
    overrideCounts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
