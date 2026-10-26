// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryHash as serverEntryHash, verifyChain as serverVerifyChain } from '../../functions/shared/audit.ts';
import { entryHash, GENESIS_HASH, verifyChain, type AuditEntry } from '../../shared/audit-chain.ts';
import { canonicalJson, computePlan, inputsHash, planHash, type DrawInputs } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { canonicalFrozenInputs, FrozenInputsError, frozenInputsHash, parseFrozenInputs, serializeFrozenInputs, summarizeFrozenInputs } from '../../shared/freeze/canonical.ts';
import {
  announcedRound,
  deriveSeed,
  DRAND_CHAIN,
  DRAND_VERIFIER,
  fetchBeaconFromRelays,
  firstRoundAtOrAfter,
  freezeDeadlineMs,
  ROUND_DELAY_MS,
  roundTimeMs,
  verifyBeacon,
} from '../../shared/freeze/drand.ts';
import { mulberry32 } from '../../shared/odds.ts';
import { DEFAULT_CHAIN_1000000, QUICKNET_1000000, QUICKNET_12345678 } from '../fixtures/drand-beacons.ts';

/** SYNTHETIC inputs shaped like a real freeze: 32-hex public IDs, ticket-style refs. */
const hex = (rng: () => number, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
function synthetic(seed = 1, families = 12): DrawInputs {
  const rng = mulberry32(seed);
  const weeks = ['2027-W26', '2027-W27', '2027-W28'];
  const applications = Array.from({ length: families }, () => {
    const kids = 1 + Math.floor(rng() * 3);
    return {
      publicId: hex(rng, 32),
      tier: Math.floor(rng() * 3),
      late: rng() < 0.1,
      siblingMode: (['together_only', 'together_preferred', 'independent'] as const)[Math.floor(rng() * 3)] ?? 'independent',
      children: Array.from({ length: kids }, () => {
        const ranked = [...weeks].sort(() => rng() - 0.5).slice(0, 1 + Math.floor(rng() * 3));
        const g = rng() < 0.5 ? '5-7' : '8-10';
        return { ref: `tk${hex(rng, 34)}`, rankedWeeks: ranked, ageGroups: ranked.map(() => g), requested: 1 + Math.floor(rng() * 2) };
      }),
    };
  });
  return {
    schema: 'draw-inputs-v1',
    algorithm: 'even-odds-draw-v1',
    programId: 'synthetic-freeze',
    maxWeeks: 2,
    sessions: weeks.flatMap((w) => ['5-7', '8-10'].map((g) => ({ week: w, ageGroup: g, capacity: 1 + Math.floor(rng() * 4) }))),
    applications,
    overrides: [
      { publicId: applications[0]?.publicId ?? '', reasonCode: 'accommodation', pool: 'accommodation' },
      { publicId: applications[1]?.publicId ?? '', reasonCode: 'sibling_enrolled', pool: 'general' },
    ],
  };
}

const clone = <T>(x: T): T => structuredClone(x);
const must = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error('fixture: missing element');
  return x;
};
const at = <T>(xs: readonly T[], i: number): T => must(xs[i]);
const shuffled = <T>(xs: readonly T[], rng: () => number): T[] => [...xs].map((x) => ({ x, k: rng() })).sort((a, b) => a.k - b.k).map((e) => e.x);
const hashOf = (inputs: unknown) => frozenInputsHash(serializeFrozenInputs(inputs));

describe('canonical frozen inputs (even-odds-frozen-inputs-v1)', () => {
  const base = synthetic();
  const text = serializeFrozenInputs(base);
  const hash = frozenInputsHash(text);

  it('hashes the exact UTF-8 bytes of the canonical text with SHA-256', () => {
    expect(hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(text).not.toMatch(/\s/); // no insignificant whitespace (codes contain none)
  });

  it('equals the draw module inputsHash, so programs.inputs_hash, draw_runs.inputs_hash and the plan agree', () => {
    const canonical = canonicalFrozenInputs(base);
    expect(inputsHash(canonical)).toBe(hash);
    expect(computePlan(canonical, 'a'.repeat(64)).inputsHash).toBe(hash);
  });

  it('round-trips: parsing the published text gives back the same inputs and hash', () => {
    const parsed = parseFrozenInputs(text);
    expect(parsed.hash).toBe(hash);
    expect(serializeFrozenInputs(parsed.inputs)).toBe(text);
  });

  it('does not depend on the order rows were read in (records and children are sorted)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 20; i++) {
      const raw = clone(base);
      raw.sessions = shuffled(raw.sessions, rng);
      raw.overrides = shuffled(raw.overrides, rng);
      raw.applications = shuffled(raw.applications, rng).map((a) => ({ ...a, children: shuffled(a.children, rng) }));
      expect(serializeFrozenInputs(raw)).toBe(text);
    }
  });

  it('changes the hash for every single-field modification of the inputs', () => {
    const mutations: Record<string, (x: DrawInputs) => void> = {
      'program ID': (x) => { x.programId = 'synthetic-freezf'; },
      'max weeks': (x) => { x.maxWeeks = 3; },
      'session capacity +1': (x) => { at(x.sessions, 0).capacity += 1; },
      'session removed': (x) => { x.sessions.pop(); },
      'session week code': (x) => { at(x.sessions, 0).week = '2027-W29'; },
      'session age group': (x) => { at(x.sessions, 0).ageGroup = '11-13'; },
      'tier': (x) => { at(x.applications, 2).tier = (at(x.applications, 2).tier + 1) % 3; },
      'late flag': (x) => { at(x.applications, 2).late = !at(x.applications, 2).late; },
      'sibling mode': (x) => { const a = at(x.applications, 2); a.siblingMode = a.siblingMode === 'independent' ? 'together_only' : 'independent'; },
      'withdrawn': (x) => { at(x.applications, 2).withdrawn = true; },
      'public ID': (x) => { at(x.applications, 2).publicId = 'f'.repeat(32); },
      'application removed': (x) => { x.applications.splice(3, 1); },
      'application added': (x) => { x.applications.push({ publicId: 'e'.repeat(32), tier: 1, late: false, siblingMode: 'independent', children: [{ ref: 'tk-new', rankedWeeks: ['2027-W26'], ageGroups: ['5-7'], requested: 1 }] }); },
      'child ref': (x) => { at(at(x.applications, 2).children, 0).ref = 'tk-renamed'; },
      'child removed': (x) => { const a = must(x.applications.find((p) => p.children.length > 1)); a.children.pop(); },
      'ranked weeks reordered': (x) => { const c = must(x.applications.flatMap((a) => a.children).find((k) => k.rankedWeeks.length > 1)); c.rankedWeeks.reverse(); c.ageGroups.reverse(); },
      'ranked week dropped': (x) => { const c = must(x.applications.flatMap((a) => a.children).find((k) => k.rankedWeeks.length > 1)); c.rankedWeeks.pop(); c.ageGroups.pop(); },
      'age group for a week': (x) => { const c = at(at(x.applications, 2).children, 0); c.ageGroups[0] = c.ageGroups[0] === '5-7' ? '8-10' : '5-7'; },
      'requested weeks': (x) => { const c = at(at(x.applications, 2).children, 0); c.requested = c.requested === 1 ? 2 : 1; },
      'override reason': (x) => { at(x.overrides, 0).reasonCode = 'policy_exception'; },
      'override pool': (x) => { at(x.overrides, 1).pool = 'accommodation'; },
      'override removed': (x) => { x.overrides.pop(); },
      'override added': (x) => { x.overrides.push({ publicId: at(x.applications, 5).publicId, reasonCode: 'staff_family', pool: 'general' }); },
    };
    const seen = new Map<string, string>([[hash, 'original']]);
    for (const [name, mutate] of Object.entries(mutations)) {
      const changed = clone(base);
      mutate(changed);
      const h = hashOf(changed);
      expect(h, `${name} must change the hash`).not.toBe(hash);
      expect(seen.has(h), `${name} collides with ${seen.get(h) ?? ''}`).toBe(false);
      seen.set(h, name);
    }
  });

  it('changes the hash for random single-value modifications (500 trials over generated inputs)', () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 500; trial++) {
      const original = synthetic(1000 + trial, 6);
      const before = hashOf(original);
      const x = clone(original);
      const a = at(x.applications, Math.floor(rng() * x.applications.length));
      const c = at(a.children, Math.floor(rng() * a.children.length));
      const s = at(x.sessions, Math.floor(rng() * x.sessions.length));
      const pick = Math.floor(rng() * 7);
      if (pick === 0) a.tier = (a.tier + 1 + Math.floor(rng() * 8)) % 10;
      else if (pick === 1) a.late = !a.late;
      else if (pick === 2) s.capacity += 1 + Math.floor(rng() * 5);
      else if (pick === 3) c.requested = c.requested === 1 ? 2 : 1;
      else if (pick === 4) c.ref = `${c.ref}x`;
      else if (pick === 5) a.publicId = a.publicId.replace(/^./, (ch) => (ch === '0' ? '1' : '0'));
      else c.ageGroups[0] = c.ageGroups[0] === '5-7' ? '8-10' : '5-7';
      // A changed public ID may orphan an override; keep the inputs valid.
      x.overrides = x.overrides.filter((o) => x.applications.some((p) => p.publicId === o.publicId));
      if (x.overrides.length !== original.overrides.length) continue;
      expect(hashOf(x), `trial ${String(trial)} pick ${String(pick)}`).not.toBe(before);
    }
  });

  it('binds the algorithm version: a different version changes the hashed bytes and is refused by this verifier', () => {
    const v2 = text.replace('"algorithm":"even-odds-draw-v1"', '"algorithm":"even-odds-draw-v2"');
    expect(v2).not.toBe(text);
    expect(frozenInputsHash(v2)).not.toBe(hash);
    expect(() => parseFrozenInputs(v2)).toThrow(/algorithm/);
  });

  it('rejects a published file that is not byte-for-byte canonical', () => {
    const parsed = JSON.parse(text) as DrawInputs;
    const variants = {
      'pretty-printed': JSON.stringify(parsed, null, 2),
      'trailing newline': `${text}\n`,
      'records reordered': JSON.stringify({ ...parsed, applications: [...parsed.applications].reverse() }),
      'keys reordered': JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())),
      'explicit withdrawn:false': text.replace('"late":', '"withdrawn":false,"late":'),
    };
    for (const [name, v] of Object.entries(variants)) {
      expect(v, name).not.toBe(text);
      expect(() => parseFrozenInputs(v), name).toThrow(FrozenInputsError);
    }
    expect(() => parseFrozenInputs('{not json')).toThrow(/not valid JSON/);
  });

  it('refuses personal data, secrets and loose types (allow-list, never silently dropped)', () => {
    const bad: Record<string, (x: Record<string, unknown> & DrawInputs) => void> = {
      'child first name': (x) => { (at(x.applications, 0).children[0] as unknown as Record<string, unknown>).firstName = 'Ada'; },
      'child birthdate': (x) => { (at(x.applications, 0).children[0] as unknown as Record<string, unknown>).birthdate = '2018-01-01'; },
      'home location': (x) => { (x.applications[0] as unknown as Record<string, unknown>).home = [-77, 38]; },
      'family ID': (x) => { (x.applications[0] as unknown as Record<string, unknown>).familyId = 'fa123'; },
      'secret at top level': (x) => { x.childKeySecret = 'x'.repeat(40); },
      'email as public ID': (x) => { at(x.applications, 0).publicId = 'parent@example.com'; },
      'space in ref': (x) => { at(at(x.applications, 0).children, 0).ref = 'Ada Lovelace'; },
      'fractional tier': (x) => { at(x.applications, 0).tier = 1.5; },
      'string capacity': (x) => { (x.sessions[0] as unknown as Record<string, unknown>).capacity = '3'; },
      'negative capacity': (x) => { at(x.sessions, 0).capacity = -1; },
      'unknown reason code': (x) => { (x.overrides[0] as unknown as Record<string, unknown>).reasonCode = 'friend_of_staff'; },
      'override without application': (x) => { at(x.overrides, 0).publicId = 'd'.repeat(32); },
      'duplicate override': (x) => { x.overrides.push({ ...at(x.overrides, 0) }); },
      'week ranked twice': (x) => { const c = at(at(x.applications, 0).children, 0); c.rankedWeeks = ['2027-W26', '2027-W26']; c.ageGroups = ['5-7', '5-7']; },
      'wrong algorithm': (x) => { (x as { algorithm: string }).algorithm = 'other'; },
    };
    for (const [name, mutate] of Object.entries(bad)) {
      const x = clone(base) as Record<string, unknown> & DrawInputs;
      mutate(x);
      expect(() => serializeFrozenInputs(x), name).toThrow(FrozenInputsError);
    }
  });

  it('publishes counts and override reason categories that anyone can recompute', () => {
    expect(summarizeFrozenInputs(canonicalFrozenInputs(SAMPLE_INPUTS))).toEqual({
      applications: 6, children: 8, sessions: 4, seats: 6, overrides: 1, overrideCounts: { accommodation: 1 },
    });
    expect(summarizeFrozenInputs(base).overrideCounts).toEqual({ accommodation: 1, sibling_enrolled: 1 });
  });
});

describe('drand beacon verification (pinned quicknet, drand-client)', () => {
  it('pins the quicknet chain and the installed verifier version', () => {
    expect(DRAND_CHAIN.hash).toBe('52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971');
    expect(DRAND_CHAIN.schemeID).toBe('bls-unchained-g1-rfc9380');
    const pkg = JSON.parse(readFileSync('node_modules/drand-client/package.json', 'utf8')) as { version: string };
    expect(DRAND_VERIFIER).toBe(`drand-client ${pkg.version} (bls-unchained-g1-rfc9380)`);
  });

  it('accepts authentic beacons', async () => {
    for (const b of [QUICKNET_1000000, QUICKNET_12345678]) {
      const check = await verifyBeacon(b, b.round);
      expect(check, String(b.round)).toEqual({ ok: true, beacon: { round: b.round, randomness: b.randomness, signature: b.signature } });
    }
  });

  it('rejects invalid signatures and every other substitution', async () => {
    const flip = (h: string, i: number) => h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1);
    const cases: Record<string, [unknown, number]> = {
      'signature bit flipped': [{ ...QUICKNET_1000000, signature: flip(QUICKNET_1000000.signature, 40) }, 1000000],
      'signature from another round': [{ ...QUICKNET_1000000, signature: QUICKNET_12345678.signature }, 1000000],
      'randomness altered': [{ ...QUICKNET_1000000, randomness: flip(QUICKNET_1000000.randomness, 0) }, 1000000],
      'randomness and signature from another round': [{ ...QUICKNET_12345678, round: 1000000 }, 1000000],
      'authentic beacon, but not the announced round': [QUICKNET_12345678, 1000000],
      'round relabelled': [{ ...QUICKNET_1000000, round: 1000001 }, 1000001],
      'beacon from a different drand chain': [DEFAULT_CHAIN_1000000, 1000000],
      'signature not a curve point': [{ ...QUICKNET_1000000, signature: 'ab'.repeat(48) }, 1000000],
      'missing signature': [{ round: 1000000, randomness: QUICKNET_1000000.randomness }, 1000000],
      'not an object': ['beacon', 1000000],
    };
    for (const [name, [beacon, round]] of Object.entries(cases)) {
      const check = await verifyBeacon(beacon, round);
      expect(check.ok, name).toBe(false);
    }
  });

  it('round timing follows the pinned genesis and period', () => {
    expect(roundTimeMs(1)).toBe(DRAND_CHAIN.genesis_time * 1000);
    expect(roundTimeMs(1000000)).toBe((1692803367 + 999999 * 3) * 1000);
    const t = Date.parse('2027-02-10T14:00:00.000Z');
    const r = firstRoundAtOrAfter(t);
    expect(roundTimeMs(r)).toBeGreaterThanOrEqual(t);
    expect(roundTimeMs(r - 1)).toBeLessThan(t);
  });

  it('announces the first round at least 3 h after close, leaving the freeze window before it', () => {
    const close = '2027-02-10T14:00:00.000Z';
    const round = announcedRound(close);
    expect(roundTimeMs(round)).toBeGreaterThanOrEqual(Date.parse(close) + ROUND_DELAY_MS);
    expect(roundTimeMs(round - 1)).toBeLessThan(Date.parse(close) + ROUND_DELAY_MS);
    expect(freezeDeadlineMs(round) - Date.parse(close)).toBeGreaterThan(2 * 3600_000);
  });

  it('fetches from relays in turn; 425 means not produced yet; never verifies on its own', async () => {
    const calls: string[] = [];
    const responder = (byRelay: Record<string, () => Response>) =>
      ((url: string) => {
        calls.push(url);
        const relay = Object.keys(byRelay).find((r) => url.startsWith(r));
        const respond = relay ? byRelay[relay] : undefined;
        return respond ? Promise.resolve(respond()) : Promise.reject(new TypeError('fetch failed'));
      }) as typeof fetch;
    const relays = ['https://r1', 'https://r2'];
    const ok = await fetchBeaconFromRelays(1000000, { relays, fetch: responder({ 'https://r2': () => Response.json(QUICKNET_1000000) }) });
    expect(ok).toEqual({ status: 'ok', beacon: QUICKNET_1000000, relay: 'https://r2' });
    expect(calls[0]).toBe(`https://r1/${DRAND_CHAIN.hash}/public/1000000`);
    expect((await fetchBeaconFromRelays(9e8, { relays, fetch: responder({ 'https://r1': () => new Response('', { status: 425 }) }) })).status).toBe('not_yet');
    expect((await fetchBeaconFromRelays(1, { relays, fetch: responder({}) })).status).toBe('unavailable');
    expect((await fetchBeaconFromRelays(1, { relays, fetch: responder({ 'https://r1': () => new Response('', { status: 500 }), 'https://r2': () => new Response('', { status: 404 }) }) })).status).toBe('unavailable');
  });
});

describe('seed derivation (even-odds-seed-v1)', () => {
  const params = { chainHash: DRAND_CHAIN.hash, round: QUICKNET_1000000.round, randomness: QUICKNET_1000000.randomness, inputsHash: 'c'.repeat(64), programId: 'demo-summer-2027' };

  it('is SHA-256 of the documented newline-joined string', () => {
    const doc = ['even-odds-seed-v1', params.chainHash, '1000000', params.randomness, params.inputsHash, params.programId].join('\n');
    expect(deriveSeed(params)).toBe(createHash('sha256').update(doc, 'utf8').digest('hex'));
  });

  it('is domain-separated: every component changes the seed, and it is never the raw randomness', () => {
    const seeds = new Set([
      deriveSeed(params),
      deriveSeed({ ...params, round: params.round + 1 }),
      deriveSeed({ ...params, randomness: QUICKNET_12345678.randomness }),
      deriveSeed({ ...params, inputsHash: 'd'.repeat(64) }),
      deriveSeed({ ...params, programId: 'other-program' }),
      deriveSeed({ ...params, chainHash: 'e'.repeat(64) }),
      params.randomness,
    ]);
    expect(seeds.size).toBe(7);
  });

  it('rejects malformed components', () => {
    expect(() => deriveSeed({ ...params, randomness: 'XYZ' })).toThrow();
    expect(() => deriveSeed({ ...params, round: 0 })).toThrow();
    expect(() => deriveSeed({ ...params, inputsHash: 'C'.repeat(64) })).toThrow();
  });
});

describe('replay: same verified inputs and seed give the same lottery plan', () => {
  it('reproduces the plan byte for byte from the published text and a verified beacon', async () => {
    const text = serializeFrozenInputs(synthetic(3, 40));
    const { inputs, hash } = parseFrozenInputs(text);
    const check = await verifyBeacon(QUICKNET_1000000, 1000000);
    if (!check.ok) throw new Error(check.reason);
    const seed = deriveSeed({ chainHash: DRAND_CHAIN.hash, round: 1000000, randomness: check.beacon.randomness, inputsHash: hash, programId: inputs.programId });

    const first = computePlan(inputs, seed);
    const again = computePlan(parseFrozenInputs(text).inputs, seed);
    // Rebuilt from shuffled raw rows, as a second server or an auditor would.
    const rng = mulberry32(5);
    const raw = JSON.parse(text) as DrawInputs;
    const rebuilt = canonicalFrozenInputs({ ...raw, applications: shuffled(raw.applications, rng), sessions: shuffled(raw.sessions, rng) });
    const third = computePlan(rebuilt, seed);

    expect(canonicalJson(again)).toBe(canonicalJson(first));
    expect(planHash(third)).toBe(planHash(first));
    expect(first.inputsHash).toBe(hash);
    expect(first.seed).toBe(seed);
    expect(first.summary.placements).toBeGreaterThan(0);
  });

  it('a different verified beacon gives a different order (the seed matters)', () => {
    const { inputs, hash } = parseFrozenInputs(serializeFrozenInputs(synthetic(3, 40)));
    const seedOf = (b: { round: number; randomness: string }) => deriveSeed({ chainHash: DRAND_CHAIN.hash, round: b.round, randomness: b.randomness, inputsHash: hash, programId: inputs.programId });
    const a = computePlan(inputs, seedOf(QUICKNET_1000000));
    const b = computePlan(inputs, seedOf(QUICKNET_12345678));
    expect(a.order.map((o) => o.publicId)).not.toEqual(b.order.map((o) => o.publicId));
  });
});

describe('audit hash chain (shared verifier used by the browser)', () => {
  const chain = (events: string[]): AuditEntry[] => {
    let prev = GENESIS_HASH;
    return events.map((event, i) => {
      const payload = canonicalJson({ i, event });
      const payload_hash = createHash('sha256').update(payload).digest('hex');
      const e = { seq: i + 1, event, payload, payload_hash, prev_hash: prev, entry_hash: entryHash(prev, i + 1, event, payload_hash) };
      prev = e.entry_hash;
      return e;
    });
  };

  it('matches the server implementation and detects edits', () => {
    const entries = chain(['program_published', 'inputs_frozen', 'beacon_verified', 'draw_completed']);
    expect(entries.map((e) => serverEntryHash(e.prev_hash, e.seq, e.event, e.payload_hash))).toEqual(entries.map((e) => e.entry_hash));
    expect(verifyChain(entries)).toEqual({ ok: true });
    expect(serverVerifyChain(entries)).toEqual({ ok: true });
    const edited = entries.map((e) => (e.seq === 2 ? { ...e, payload: e.payload.replace('inputs_frozen', 'inputs_frozeN') } : e));
    expect(verifyChain(edited)).toEqual({ ok: false, seq: 2, reason: 'payload hash mismatch' });
    expect(verifyChain(entries.filter((e) => e.seq !== 3))).toMatchObject({ ok: false, seq: 4 });
  });
});
