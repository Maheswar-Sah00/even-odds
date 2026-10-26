import { z } from 'zod';

/**
 * The replay bundle (`even-odds-replay-bundle-v1`): every PUBLIC artifact a
 * replay needs, in one JSON file. The browser builds it from public rows and
 * drand; a visitor can download it, edit it (to see verification fail), and
 * load it back, or verify it with no network at all. It deliberately carries
 * no server verdicts (no "beacon_verified: true", no "valid"): only the raw
 * artifacts, which shared/replay/replay.ts checks from scratch.
 */

export const BUNDLE_FORMAT = 'even-odds-replay-bundle-v1';

export interface BundleProgram {
  id: string;
  /** "demo" for judge sandboxes (demo timing rule), else null. */
  namespace: string | null;
  status: string;
  windowClose: string;
  drandRound: number | null;
  drandChain: string | null;
  inputsHash: string | null;
}

export interface BundleSnapshot {
  canonical: string;
  inputsHash: string;
  frozenAt: string;
  drandRound: number;
  drandChain: string;
  counts: { applications: number; children: number; sessions: number; seats: number; overrides: number; overrideCounts: string };
  applicationOrder: string | null;
  applicationOrderHash: string | null;
}

export interface BundleRun {
  id: string;
  status: string;
  drandRound: number;
  inputsHash: string;
  seedScheme: string | null;
  seed: string | null;
  planHash: string | null;
  beaconRandomness: string | null;
  beaconSignature: string | null;
  cursor: number;
  error: string | null;
}

export interface BundleBeacon {
  round: number;
  randomness: string;
  signature: string;
  /** Where it came from, e.g. "https://api.drand.sh" or "server copy". Informational only. */
  source: string;
}

export interface BundleResult {
  canonical: string;
  resultHash: string;
  drawRunId: string;
  placements: number;
  waitlist: number;
  outcomes: string | null;
  outcomesAt: string | null;
}

export interface ReplayBundle {
  format: typeof BUNDLE_FORMAT;
  exportedAt: string;
  program: BundleProgram;
  snapshot: BundleSnapshot | null;
  run: BundleRun | null;
  beacon: BundleBeacon | null;
  result: BundleResult | null;
  /** Audit records as published. Kept loosely typed: malformed records must reach the integrity check, not be dropped here. */
  audit: unknown[];
}

const str = z.string();
const nstr = z.string().nullable();
const nint = z.number().int().nullable();
const count = z.number().int().min(0);

const bundleSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  exportedAt: str,
  program: z.strictObject({ id: str, namespace: nstr, status: str, windowClose: str, drandRound: nint, drandChain: nstr, inputsHash: nstr }),
  snapshot: z
    .strictObject({
      canonical: str,
      inputsHash: str,
      frozenAt: str,
      drandRound: z.number().int(),
      drandChain: str,
      counts: z.strictObject({ applications: count, children: count, sessions: count, seats: count, overrides: count, overrideCounts: str }),
      applicationOrder: nstr,
      applicationOrderHash: nstr,
    })
    .nullable(),
  run: z
    .strictObject({
      id: str,
      status: str,
      drandRound: z.number().int(),
      inputsHash: str,
      seedScheme: nstr,
      seed: nstr,
      planHash: nstr,
      beaconRandomness: nstr,
      beaconSignature: nstr,
      cursor: count,
      error: nstr,
    })
    .nullable(),
  beacon: z.strictObject({ round: z.number().int(), randomness: str, signature: str, source: str }).nullable(),
  result: z.strictObject({ canonical: str, resultHash: str, drawRunId: str, placements: count, waitlist: count, outcomes: nstr, outcomesAt: nstr }).nullable(),
  audit: z.array(z.unknown()),
});

/** Parses a bundle file. Shape problems are reported here; whether the CONTENTS are genuine is for replayBundle(). */
export function parseBundle(text: string): ReplayBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The bundle is not valid JSON.');
  }
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The bundle does not have the expected shape: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'bundle'}: ${i.message}`).join('; ')}.`);
  return parsed.data;
}

export const serializeBundle = (b: ReplayBundle): string => JSON.stringify(b, null, 2);
