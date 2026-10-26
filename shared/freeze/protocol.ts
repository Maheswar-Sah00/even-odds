import type { ChainInfo } from 'drand-client';
import { sha256Hex } from '../draw/sha256.ts';

/**
 * The fixed parameters of the freeze-and-verify protocol
 * (docs/FREEZE-PROTOCOL.md): the pinned drand chain, round timing, the
 * announcement rule and seed derivation. No runtime dependencies, so pages
 * that only need timing do not load the BLS verifier (shared/freeze/drand.ts).
 */

/** drand mainnet "quicknet": unchained, BLS signatures on G1 (RFC 9380), one round every 3 s. */
export const DRAND_CHAIN: ChainInfo = Object.freeze({
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: Object.freeze({ beaconID: 'quicknet' }),
});

/** Official HTTP relays; any of them may serve the beacon, none of them is trusted for it. */
export const DRAND_RELAYS = ['https://api.drand.sh', 'https://api2.drand.sh', 'https://drand.cloudflare.com'] as const;

/** Must match the installed drand-client (checked by tests/unit/drand.test.ts). */
export const DRAND_VERIFIER = 'drand-client 1.4.2 (bls-unchained-g1-rfc9380)';

/** The announced round is the first one at least this long after applications close. */
export const ROUND_DELAY_MS = 3 * 3600_000;
/** The freeze must commit at least this long before the announced round is due. */
export const FREEZE_MARGIN_MS = 30 * 60_000;

/**
 * Timing profiles. "standard" is the production rule above. "demo" applies
 * ONLY to judge-sandbox programs (programs.namespace = "demo", Task 12) so a
 * draw can be watched live: the round is due 45 s after the (fast-forwarded)
 * close and the freeze must commit 15 s before it. The rule is still a pure
 * function of window_close, and the round still does not exist when the
 * inputs are frozen. Production programs can never use it.
 */
export type TimingProfile = 'standard' | 'demo';
export const TIMING: Readonly<Record<TimingProfile, { roundDelayMs: number; freezeMarginMs: number }>> = Object.freeze({
  standard: { roundDelayMs: ROUND_DELAY_MS, freezeMarginMs: FREEZE_MARGIN_MS },
  demo: { roundDelayMs: 45_000, freezeMarginMs: 15_000 },
});

/** The timing profile a program uses: demo sandboxes only, everything else standard. */
export const timingOf = (program: { namespace?: string | null }): TimingProfile => (program.namespace === 'demo' ? 'demo' : 'standard');

/** When `round` is due (ms since epoch): genesis + (round - 1) x period. */
export const roundTimeMs = (round: number, chain: ChainInfo = DRAND_CHAIN): number => (chain.genesis_time + (round - 1) * chain.period) * 1000;

/** The first round whose time is at or after `ms`. */
export function firstRoundAtOrAfter(ms: number, chain: ChainInfo = DRAND_CHAIN): number {
  return Math.max(1, Math.ceil((ms / 1000 - chain.genesis_time) / chain.period) + 1);
}

/**
 * The round a program commits to when it is published. A pure function of the
 * window close time (set while the program was a draft), so it is fixed before
 * any of its output exists and cannot be picked after the fact.
 */
export const announcedRound = (windowCloseIso: string, profile: TimingProfile = 'standard'): number =>
  firstRoundAtOrAfter(Date.parse(windowCloseIso) + TIMING[profile].roundDelayMs);

/** Last moment a freeze may commit for this round. */
export const freezeDeadlineMs = (round: number, profile: TimingProfile = 'standard'): number => roundTimeMs(round) - TIMING[profile].freezeMarginMs;

export const SEED_SCHEME = 'even-odds-seed-v1';

/**
 * Draw seed from a VERIFIED beacon, domain-separated (even-odds-seed-v1):
 *
 *   SHA-256( UTF-8( "even-odds-seed-v1\n" chainHash "\n" round "\n" randomness "\n" inputsHash "\n" programId ) )
 *
 * Hex fields lowercase, round in decimal. Binding the inputs hash and program
 * means the same beacon gives unrelated seeds to different programs, and a
 * seed is only valid for the inputs that were frozen before the round existed.
 */
export function deriveSeed(p: { chainHash: string; round: number; randomness: string; inputsHash: string; programId: string }): string {
  if (!/^[0-9a-f]{64}$/.test(p.chainHash) || !/^[0-9a-f]{64}$/.test(p.randomness) || !/^[0-9a-f]{64}$/.test(p.inputsHash)) {
    throw new Error('chainHash, randomness and inputsHash must be 64 lowercase hex characters');
  }
  if (!Number.isSafeInteger(p.round) || p.round < 1) throw new Error('round must be a positive integer');
  return sha256Hex([SEED_SCHEME, p.chainHash, String(p.round), p.randomness, p.inputsHash, p.programId].join('\n'));
}
