import { fetchBeacon, type ChainClient, type ChainInfo } from 'drand-client';
import { DRAND_CHAIN, DRAND_RELAYS } from './protocol.ts';

export * from './protocol.ts';

/**
 * Public randomness from drand (League of Entropy), specified in
 * docs/FREEZE-PROTOCOL.md. Pure apart from the injectable `fetch`; the server
 * (jobs Function) and the browser verifier run this same file.
 *
 * Trust root: the chain info is PINNED in code (DRAND_CHAIN in protocol.ts),
 * including the group public key. Chain info served by the network is never used to verify, so a
 * mirror (or anyone in between) can withhold a beacon but cannot forge one.
 * Signature checks are done by the drand team's maintained client
 * (`drand-client`, BLS12-381 via @noble/curves).
 */

export interface BeaconRecord {
  round: number;
  randomness: string;
  signature: string;
}

export type BeaconCheck = { ok: true; beacon: BeaconRecord } | { ok: false; reason: string };

/**
 * Verifies a beacon for `expectedRound` against the pinned chain, through the
 * official client's own verification path (fetchBeacon with verification on):
 * round must match, randomness must equal SHA-256(signature), and the BLS
 * signature must verify under the pinned group key.
 */
export async function verifyBeacon(raw: unknown, expectedRound: number, chain: ChainInfo = DRAND_CHAIN): Promise<BeaconCheck> {
  const b = raw as Partial<Record<keyof BeaconRecord, unknown>> | null;
  if (!b || typeof b !== 'object') return { ok: false, reason: 'Beacon is not an object.' };
  if (!Number.isSafeInteger(b.round) || (b.round as number) < 1) return { ok: false, reason: 'Beacon round is not a positive integer.' };
  if (b.round !== expectedRound) return { ok: false, reason: `Beacon is for round ${String(b.round)}, not the announced round ${String(expectedRound)}.` };
  if (typeof b.randomness !== 'string' || !/^[0-9a-f]{64}$/.test(b.randomness)) return { ok: false, reason: 'Beacon randomness is not 64 lowercase hex characters.' };
  if (typeof b.signature !== 'string' || !/^(?:[0-9a-f]{2}){48,96}$/.test(b.signature)) return { ok: false, reason: 'Beacon signature is not hex of a BLS signature.' };
  const beacon: BeaconRecord = { round: b.round, randomness: b.randomness, signature: b.signature };

  // A ChainClient that serves only this stored beacon and the pinned chain info: nothing comes from the network.
  const client: ChainClient = {
    options: { disableBeaconVerification: false, noCache: true, chainVerificationParams: { chainHash: chain.hash, publicKey: chain.public_key } },
    latest: () => Promise.reject(new Error('not available')),
    get: (round: number) => (round === beacon.round ? Promise.resolve(beacon) : Promise.reject(new Error('wrong round'))),
    chain: () => ({ baseUrl: 'pinned:', info: () => Promise.resolve(chain) }),
  };
  try {
    await fetchBeacon(client, expectedRound);
    return { ok: true, beacon };
  } catch (err) {
    // Malformed curve points throw inside the verifier; treat every failure as "not verified".
    return { ok: false, reason: `Signature does not verify for the pinned drand chain (${err instanceof Error ? err.message : String(err)}).` };
  }
}

export type BeaconFetch =
  | { status: 'ok'; beacon: unknown; relay: string }
  | { status: 'not_yet'; detail: string }
  | { status: 'unavailable'; detail: string };

/**
 * Fetches the beacon for `round` from the relays in turn. HTTP 425 ("too
 * early") means the round does not exist yet. Returns the raw body: callers
 * MUST pass it through verifyBeacon before using it.
 */
export async function fetchBeaconFromRelays(
  round: number,
  opts: { fetch?: typeof fetch; relays?: readonly string[]; timeoutMs?: number; chain?: ChainInfo } = {},
): Promise<BeaconFetch> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const chain = opts.chain ?? DRAND_CHAIN;
  const problems: string[] = [];
  let tooEarly = false;
  for (const relay of opts.relays ?? DRAND_RELAYS) {
    try {
      const res = await doFetch(`${relay}/${chain.hash}/public/${String(round)}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      if (res.status === 425) {
        tooEarly = true;
        problems.push(`${relay}: round not produced yet`);
        continue;
      }
      if (!res.ok) {
        problems.push(`${relay}: HTTP ${String(res.status)}`);
        continue;
      }
      return { status: 'ok', beacon: (await res.json()) as unknown, relay };
    } catch (err) {
      problems.push(`${relay}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return tooEarly ? { status: 'not_yet', detail: problems.join('; ') } : { status: 'unavailable', detail: problems.join('; ') };
}
