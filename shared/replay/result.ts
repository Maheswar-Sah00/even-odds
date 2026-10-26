import { z } from 'zod';
import { canonicalJson } from '../draw/plan.ts';
import { sha256Hex } from '../draw/sha256.ts';
import { PLACEMENT_STATUSES } from '../schema.ts';

/**
 * The published draw result (`even-odds-result-v1`) and the committed
 * application order, specified in docs/REPLAY.md. Pure and isomorphic: the
 * server writes these after the draw commits (functions/shared/draw-result.ts)
 * and the browser replay parses them with this same file.
 *
 * The result is read back from the COMMITTED database rows (placements made
 * by the draw run, and the initial waitlist), never copied from the plan, so
 * comparing a browser replay with it tests that the database holds what the
 * algorithm computed.
 *
 * Same rules as the frozen inputs (docs/FREEZE-PROTOCOL.md): strict
 * allow-list (an unknown field is an error), fully ordered records, integers
 * only, identifiers of A-Z a-z 0-9 . _ -, canonical JSON, and a file is valid
 * only if re-serializing it gives back the identical text.
 */

export const RESULT_FORMAT = 'even-odds-result-v1';

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const ident = (what: string) => z.string().regex(IDENT, `${what} must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" or "-"`);
const hash = (what: string) => z.string().regex(HASH, `${what} must be 64 lowercase hex characters`);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export interface ResultPlacement {
  publicId: string;
  /** Ticket ID: the same child ref as in the frozen inputs. */
  childRef: string;
  week: string;
  ageGroup: string;
  /** Snake-draft round recorded on the committed placement. */
  round: number;
}

export interface ResultWaitlistEntry {
  week: string;
  ageGroup: string;
  position: number;
  publicId: string;
  childRef: string;
}

export interface PublishedResult {
  format: typeof RESULT_FORMAT;
  programId: string;
  drawRunId: string;
  /** Inputs hash the run drew from (server-recorded). */
  inputsHash: string;
  /** Plan hash the server recorded when the run started. */
  planHash: string;
  /** Placements created by the draw run, by (childRef, week). */
  placements: ResultPlacement[];
  /** The waitlist as the draw wrote it, by (week, ageGroup, position). */
  waitlist: ResultWaitlistEntry[];
}

const resultSchema = z.strictObject({
  format: z.literal(RESULT_FORMAT),
  programId: ident('Program ID'),
  drawRunId: ident('Draw run ID'),
  inputsHash: hash('Inputs hash'),
  planHash: hash('Plan hash'),
  placements: z.array(z.strictObject({ publicId: ident('Public ID'), childRef: ident('Child ref'), week: ident('Week'), ageGroup: ident('Age group'), round: int(1, 12) })),
  waitlist: z.array(z.strictObject({ week: ident('Week'), ageGroup: ident('Age group'), position: int(1, 1_000_000), publicId: ident('Public ID'), childRef: ident('Child ref') })),
});

export class PublishedArtifactError extends Error {
  readonly problems: string[];

  constructor(what: string, problems: string[]) {
    super(`${what} is not valid: ${problems.join('; ')}`);
    this.name = 'PublishedArtifactError';
    this.problems = problems;
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pad = (n: number) => String(n).padStart(7, '0');
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);

/** Validates and returns the canonical form. Throws PublishedArtifactError listing every problem. */
export function canonicalResult(raw: unknown): PublishedResult {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) throw new PublishedArtifactError('Published result', issues(parsed.error));
  const p = parsed.data;
  const result: PublishedResult = {
    format: p.format,
    programId: p.programId,
    drawRunId: p.drawRunId,
    inputsHash: p.inputsHash,
    planHash: p.planHash,
    placements: p.placements
      .map((x) => ({ publicId: x.publicId, childRef: x.childRef, week: x.week, ageGroup: x.ageGroup, round: x.round }))
      .sort((a, b) => cmp(`${a.childRef}\u0000${a.week}`, `${b.childRef}\u0000${b.week}`)),
    waitlist: p.waitlist
      .map((x) => ({ week: x.week, ageGroup: x.ageGroup, position: x.position, publicId: x.publicId, childRef: x.childRef }))
      .sort((a, b) => cmp(`${a.week}\u0000${a.ageGroup}\u0000${pad(a.position)}`, `${b.week}\u0000${b.ageGroup}\u0000${pad(b.position)}`)),
  };
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const x of result.placements) {
    const k = `${x.childRef}\u0000${x.week}`;
    if (seen.has(k)) problems.push(`Child ${x.childRef} is placed in ${x.week} twice`);
    seen.add(k);
  }
  const slots = new Set<string>();
  for (const w of result.waitlist) {
    const k = `${w.week}\u0000${w.ageGroup}\u0000${String(w.position)}`;
    if (slots.has(k)) problems.push(`Waitlist ${w.week}/${w.ageGroup} has two entries at position ${String(w.position)}`);
    slots.add(k);
  }
  if (problems.length > 0) throw new PublishedArtifactError('Published result', problems);
  return result;
}

/** The exact text that is hashed and published. */
export const serializeResult = (raw: unknown): string => canonicalJson(canonicalResult(raw));

/** SHA-256 (lowercase hex) of the UTF-8 bytes of a canonical text. */
export const artifactHash = (canonical: string): string => sha256Hex(canonical);

function parseCanonical(what: string, text: string, serialize: (raw: unknown) => string): { value: unknown; hash: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PublishedArtifactError(what, ['not valid JSON']);
  }
  const canonical = serialize(raw);
  if (canonical !== text) throw new PublishedArtifactError(what, ['not in canonical form (key order, record order, whitespace or fields differ)']);
  return { value: JSON.parse(canonical) as unknown, hash: artifactHash(canonical) };
}

/** Parses a published result and proves it is canonical. */
export function parseResult(text: string): { result: PublishedResult; hash: string } {
  const { value, hash: h } = parseCanonical('Published result', text, serializeResult);
  return { result: value as PublishedResult, hash: h };
}

// ---- Application order (committed at freeze) ------------------------------------------

/**
 * Public IDs of the frozen applications in submission order (submitted_at
 * ascending, ties by public ID; late applications are simply the latest).
 * No timestamps are published. Committed in the freeze transaction, before the
 * random value exists, so it cannot be arranged after seeing the result. It
 * is NOT a draw input: the lottery never reads it. It exists for the fairness
 * report's application-time groups and first-come baseline.
 */
const orderSchema = z.array(ident('Public ID')).max(1_000_000);

/** Submission order from (publicId, submittedAt) pairs: earliest first, ties and missing times (last) by public ID. */
export function applicationOrderOf(apps: readonly { publicId: string; submittedAt: string | null }[]): string[] {
  const ms = (t: string | null) => (t === null ? Number.POSITIVE_INFINITY : Date.parse(t));
  return [...apps].sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt) || cmp(a.publicId, b.publicId)).map((a) => a.publicId);
}

export function canonicalApplicationOrder(raw: unknown): string[] {
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) throw new PublishedArtifactError('Application order', issues(parsed.error));
  const dupes = parsed.data.filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length > 0) throw new PublishedArtifactError('Application order', [`${dupes[0] ?? ''} appears more than once`]);
  return [...parsed.data];
}

export const serializeApplicationOrder = (raw: unknown): string => JSON.stringify(canonicalApplicationOrder(raw));

export function parseApplicationOrder(text: string): { order: string[]; hash: string } {
  const { value, hash: h } = parseCanonical('Application order', text, serializeApplicationOrder);
  return { order: value as string[], hash: h };
}

/** Problems if the order is not exactly the frozen applications (each once). */
export function applicationOrderProblems(order: readonly string[], publicIds: readonly string[]): string[] {
  const want = new Set(publicIds);
  const have = new Set(order);
  const problems: string[] = [];
  const missing = publicIds.filter((id) => !have.has(id));
  const extra = order.filter((id) => !want.has(id));
  if (missing.length > 0) problems.push(`${String(missing.length)} frozen application(s) missing from the order, e.g. ${missing[0] ?? ''}`);
  if (extra.length > 0) problems.push(`${String(extra.length)} ID(s) in the order that are not frozen applications, e.g. ${extra[0] ?? ''}`);
  return problems;
}

// ---- Outcomes (live, NOT hashed) ---------------------------------------------------------

/**
 * Current offer and waitlist status per draw placement and waitlist entry,
 * refreshed by the offers job. Mutable by design (offers are accepted,
 * declined, expire), so it is not part of the result hash and the replay only
 * displays it; it is the server's word about events after the draw.
 */
export interface OutcomeEntry {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
  source: 'draw' | 'waitlist';
  status: (typeof PLACEMENT_STATUSES)[number];
}

export interface OutcomeWaitlistEntry {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
  position: number;
  status: 'waiting' | 'promoted' | 'removed';
}

export interface ResultOutcomes {
  /** ISO 8601 UTC, server time of the recount. */
  computedAt: string;
  entries: OutcomeEntry[];
  waitlist: OutcomeWaitlistEntry[];
}

const outcomesSchema = z.strictObject({
  computedAt: z.iso.datetime(),
  entries: z.array(z.strictObject({ publicId: ident('Public ID'), childRef: ident('Child ref'), week: ident('Week'), ageGroup: ident('Age group'), source: z.enum(['draw', 'waitlist']), status: z.enum(PLACEMENT_STATUSES) })),
  waitlist: z.array(z.strictObject({ publicId: ident('Public ID'), childRef: ident('Child ref'), week: ident('Week'), ageGroup: ident('Age group'), position: int(1, 1_000_000), status: z.enum(['waiting', 'promoted', 'removed']) })),
});

export function parseOutcomes(text: string): ResultOutcomes {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PublishedArtifactError('Outcomes', ['not valid JSON']);
  }
  const parsed = outcomesSchema.safeParse(raw);
  if (!parsed.success) throw new PublishedArtifactError('Outcomes', issues(parsed.error));
  return parsed.data;
}

/** Canonical outcomes text (records sorted), as the server stores it. */
export function serializeOutcomes(o: ResultOutcomes): string {
  const parsed = outcomesSchema.parse(o);
  return canonicalJson({
    computedAt: parsed.computedAt,
    entries: [...parsed.entries].sort((a, b) => cmp(`${a.childRef}\u0000${a.week}`, `${b.childRef}\u0000${b.week}`)),
    waitlist: [...parsed.waitlist].sort((a, b) => cmp(`${a.week}\u0000${a.ageGroup}\u0000${pad(a.position)}`, `${b.week}\u0000${b.ageGroup}\u0000${pad(b.position)}`)),
  });
}
