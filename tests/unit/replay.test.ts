// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { auditIntegrity, entryHash, verifyChain, type AuditEntry } from '../../shared/audit-chain.ts';
import { canonicalJson } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { sha256Hex } from '../../shared/draw/sha256.ts';
import { frozenInputsHash } from '../../shared/freeze/canonical.ts';
import type { BeaconFetch } from '../../shared/freeze/drand.ts';
import {
  applicationOrderOf,
  diffPlanAgainstResult,
  flipHex,
  parseApplicationOrder,
  parseBundle,
  parseOutcomes,
  parseResult,
  PublishedArtifactError,
  replayBundle,
  serializeBundle,
  serializeOutcomes,
  serializeResult,
  tamper,
  TAMPERS,
  type PublishedResult,
  type ReplayBundle,
  type StepKey,
  type TamperKey,
} from '../../shared/replay/index.ts';
import { QUICKNET_12345678 } from '../fixtures/drand-beacons.ts';
import { publishedFixture, ROUND_AT } from '../fixtures/replay-bundle.ts';

const NOW = ROUND_AT + 3600_000;
const statuses = (v: Awaited<ReturnType<typeof replayBundle>>) => Object.fromEntries(v.steps.map((s) => [s.key, s.status])) as Record<StepKey, string>;
const step = (v: Awaited<ReturnType<typeof replayBundle>>, key: StepKey) => v.steps.find((s) => s.key === key);

describe('replayBundle: the published draw reproduces', () => {
  it('passes every step and matches every placement for an honest publication', async () => {
    const { bundle, plan, seed } = publishedFixture();
    const v = await replayBundle(bundle, { now: NOW });
    expect(statuses(v)).toEqual({ audit: 'pass', announced: 'pass', inputs: 'pass', inputs_hash: 'pass', order: 'pass', timing: 'pass', beacon: 'pass', seed: 'pass', plan: 'pass', result: 'pass', compare: 'pass' });
    expect(v.seed).toBe(seed);
    expect(v.planHash).toBe(bundle.run?.planHash);
    expect(v.plan?.steps).toEqual(plan.steps);
    expect(v.replayMatches).toBe(true);
    expect(v.discrepancies).toEqual([]);
    expect(v.inputs?.programId).toBe('synthetic-sample');
    expect(v.applicationOrder?.order).toHaveLength(SAMPLE_INPUTS.applications.length);
    expect(v.result?.placements.length).toBe(plan.summary.placements);
  });

  it('round-trips through a downloaded bundle file', async () => {
    const { bundle } = publishedFixture();
    const v = await replayBundle(parseBundle(serializeBundle(bundle)), { now: NOW });
    expect(v.replayMatches).toBe(true);
  });

  it('fetches the beacon itself when the bundle has none, and falls back to verifying the server copy', async () => {
    const { bundle } = publishedFixture({ withBeacon: false });
    const calls: number[] = [];
    const ok = (round: number): Promise<BeaconFetch> => {
      calls.push(round);
      return Promise.resolve({ status: 'ok', beacon: { round, randomness: bundle.run?.beaconRandomness, signature: bundle.run?.beaconSignature }, relay: 'https://drand.example' });
    };
    const fetched = await replayBundle(bundle, { now: NOW, fetchBeacon: ok });
    expect(calls).toEqual([bundle.snapshot?.drandRound]);
    expect(step(fetched, 'beacon')?.summary).toMatch(/fetched from https:\/\/drand\.example by this browser/);

    const down = await replayBundle(bundle, { now: NOW, fetchBeacon: () => Promise.resolve({ status: 'unavailable', detail: 'offline' }) });
    expect(step(down, 'beacon')?.status).toBe('pass');
    expect(step(down, 'beacon')?.details.join(' ')).toMatch(/server's stored copy instead/);
    expect(down.replayMatches).toBe(true);
  });

  it('reports later steps as pending, not passed, before the round exists', async () => {
    const { bundle } = publishedFixture();
    const v = await replayBundle(bundle, { now: ROUND_AT - 60_000 });
    expect(step(v, 'beacon')?.status).toBe('pending');
    expect(['seed', 'plan', 'result', 'compare'].map((k) => step(v, k as StepKey)?.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    expect(v.replayMatches).toBeNull();
    // Artifacts whose own hashes check out are available without the beacon.
    expect(v.inputs).not.toBeNull();
    expect(v.applicationOrder).not.toBeNull();
  });

  it('does not read any server verdict: a bundle with a seed but a forged beacon fails', async () => {
    const { bundle } = publishedFixture({ withBeacon: false });
    const forged: ReplayBundle = { ...bundle, run: bundle.run ? { ...bundle.run, beaconSignature: QUICKNET_12345678.signature } : null };
    const v = await replayBundle(forged, { now: NOW });
    expect(step(v, 'beacon')?.status).toBe('fail');
    expect(v.replayMatches).toBeNull();
  });
});

describe('deliberate modifications make verification fail', () => {
  for (const key of Object.keys(TAMPERS) as TamperKey[]) {
    it(`${TAMPERS[key].label} -> fails at ${TAMPERS[key].failsAt}`, async () => {
      const { bundle } = publishedFixture();
      const v = await replayBundle(tamper(bundle, key), { now: NOW });
      expect(step(v, TAMPERS[key].failsAt as StepKey)?.status).toBe('fail');
      expect(v.replayMatches).not.toBe(true);
    });
  }

  it('a non-canonical (pretty-printed) inputs file is rejected even though its data is the same', async () => {
    const { bundle } = publishedFixture();
    const b: ReplayBundle = { ...bundle, snapshot: bundle.snapshot ? { ...bundle.snapshot, canonical: JSON.stringify(JSON.parse(bundle.snapshot.canonical), null, 2) } : null };
    const v = await replayBundle(b, { now: NOW });
    expect(step(v, 'inputs')?.status).toBe('fail');
    expect(step(v, 'inputs')?.details.join(' ')).toMatch(/canonical form/);
  });

  it('an inputs file with a personal-data field is rejected', async () => {
    const { bundle } = publishedFixture();
    const inputs = JSON.parse(bundle.snapshot?.canonical ?? '') as { applications: Record<string, unknown>[] };
    (inputs.applications[0] as Record<string, unknown>).guardianName = 'Jane';
    const b: ReplayBundle = { ...bundle, snapshot: bundle.snapshot ? { ...bundle.snapshot, canonical: canonicalJson(inputs) } : null };
    const v = await replayBundle(b, { now: NOW });
    expect(step(v, 'inputs')?.status).toBe('fail');
    expect(step(v, 'inputs')?.details.join(' ')).toMatch(/guardianName/);
  });

  it('changing the hash everywhere it is published still fails: the seed and audit chain no longer agree', async () => {
    const inputs = JSON.parse(publishedFixture().bundle.snapshot?.canonical ?? '') as typeof SAMPLE_INPUTS;
    inputs.applications[0] = { ...inputs.applications[0], tier: 7 } as (typeof inputs.applications)[0];
    const text = canonicalJson(inputs);
    const { bundle: b } = publishedFixture();
    if (!b.snapshot || !b.run) throw new Error('fixture');
    b.snapshot.canonical = text;
    // A careful forger updates the snapshot, program and run, but cannot rewrite the logged hash without breaking the chain.
    const newHash = frozenInputsHash(text);
    b.snapshot.inputsHash = newHash;
    b.program.inputsHash = newHash;
    b.run.inputsHash = newHash;
    const v = await replayBundle(b, { now: NOW });
    expect(step(v, 'inputs_hash')?.status).toBe('fail');
    expect(step(v, 'inputs_hash')?.details.join(' ')).toMatch(/audit log \(inputs_frozen\)/);
  });

  it('a result that is hashed and logged consistently but differs from the replay is caught placement by placement', async () => {
    const moved = (r: PublishedResult): PublishedResult => {
      const [first, ...rest] = r.placements;
      if (!first) throw new Error('fixture has no placements');
      const other = r.placements.find((p) => p.week !== first.week);
      return { ...r, placements: [{ ...first, week: other?.week ?? 'W9' }, ...rest] };
    };
    const { bundle } = publishedFixture({ result: moved });
    const v = await replayBundle(bundle, { now: NOW });
    expect(step(v, 'result')?.status).toBe('pass'); // the file is genuine: it is what the server published
    expect(step(v, 'compare')?.status).toBe('fail');
    expect(v.replayMatches).toBe(false);
    expect(v.discrepancies.map((d) => d.kind).sort()).toEqual(['placement_missing', 'placement_unexpected']);
    expect(v.discrepancies[0]?.message).toMatch(/database/);
  });

  it('an application order that differs from the one committed at freeze fails', async () => {
    const { bundle } = publishedFixture();
    if (!bundle.snapshot?.applicationOrder) throw new Error('fixture');
    const order = (JSON.parse(bundle.snapshot.applicationOrder) as string[]).reverse();
    const v = await replayBundle({ ...bundle, snapshot: { ...bundle.snapshot, applicationOrder: JSON.stringify(order) } }, { now: NOW });
    expect(step(v, 'order')?.status).toBe('fail');
    expect(v.applicationOrder).toBeNull();
  });

  it('programs frozen before the order was committed say so instead of passing', async () => {
    const { bundle } = publishedFixture({ applicationOrder: null });
    const v = await replayBundle(bundle, { now: NOW });
    expect(step(v, 'order')?.status).toBe('skipped');
    expect(v.applicationOrder).toBeNull();
    expect(v.replayMatches).toBe(true);
  });

  it('an announced round that does not follow the rule fails', async () => {
    const { bundle } = publishedFixture();
    const v = await replayBundle({ ...bundle, program: { ...bundle.program, windowClose: new Date(ROUND_AT).toISOString() } }, { now: NOW });
    expect(step(v, 'announced')?.status).toBe('fail');
  });

  it('a missing result_published entry (log cut short) fails the audit step', async () => {
    const { bundle } = publishedFixture();
    const v = await replayBundle({ ...bundle, audit: bundle.audit.slice(0, -1) }, { now: NOW });
    expect(step(v, 'audit')?.status).toBe('fail');
    expect(step(v, 'audit')?.details.join(' ')).toMatch(/no "result_published" entry/);
    expect(v.result).toBeNull();
  });
});

describe('auditIntegrity', () => {
  const entries = () => publishedFixture().bundle.audit as AuditEntry[];

  it('agrees with verifyChain on an intact log and reports its head', () => {
    const e = entries();
    expect(verifyChain(e)).toEqual({ ok: true });
    const r = auditIntegrity(e);
    expect(r).toMatchObject({ ok: true, records: 5, verified: 5, lastSeq: 5, issues: [] });
    expect(r.head).toBe(e[4]?.entry_hash);
  });

  it('reports every problem, not only the first', () => {
    const e = entries();
    const tampered: unknown[] = [
      e[0],
      { ...e[1], payload: (e[1]?.payload ?? '').replace('drand_round', 'drand_rounD') }, // payload altered
      // e[2] removed
      { ...e[3], event: 'draw_failed' }, // entry altered
      e[4],
      { ...e[4], payload_hash: 'xyz' }, // malformed
    ];
    const r = auditIntegrity(tampered);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => [i.seq, i.kind])).toEqual([
      [5, 'malformed'],
      [2, 'payload_altered'],
      [3, 'missing'],
      [4, 'entry_altered'],
    ]);
    expect(r.head).toBe(e[0]?.entry_hash);
    expect(r.issues.find((i) => i.kind === 'missing')?.message).toMatch(/removed or never published/);
  });

  it('detects forks (two entries with one number) and a replaced earlier entry', () => {
    const e = entries();
    const fork = auditIntegrity([...e, { ...e[2], payload: '{}', payload_hash: 'a'.repeat(64) }]);
    expect(fork.issues.some((i) => i.kind === 'duplicate' && i.seq === 3)).toBe(true);
    // Re-hash entry 2 consistently: its own hashes pass, but entry 3 no longer links to it.
    const second = e[1] as AuditEntry;
    const rehashed = { ...second, payload: '{"x":1}', payload_hash: '' };
    rehashed.payload_hash = sha256Hex(rehashed.payload);
    rehashed.entry_hash = entryHash(rehashed.prev_hash, 2, rehashed.event, rehashed.payload_hash);
    const r = auditIntegrity([e[0], rehashed, e[2], e[3], e[4]]);
    expect(r.issues.map((i) => [i.seq, i.kind])).toEqual([[3, 'link_broken']]);
  });
});

describe('published result format', () => {
  const { bundle } = publishedFixture();
  const text = bundle.result?.canonical ?? '';

  it('parses only the canonical text and hashes its bytes', () => {
    const { result, hash } = parseResult(text);
    expect(serializeResult(result)).toBe(text);
    expect(hash).toBe(bundle.result?.resultHash);
    expect(() => parseResult(JSON.stringify(JSON.parse(text), null, 1))).toThrow(PublishedArtifactError);
  });

  it('rejects unknown fields, so personal data cannot ride along', () => {
    const raw = JSON.parse(text) as { placements: Record<string, unknown>[] };
    (raw.placements[0] as Record<string, unknown>).childName = 'Sam';
    expect(() => serializeResult(raw)).toThrow(/childName|Unrecognized/);
  });

  it('rejects a child placed in one week twice', () => {
    const raw = JSON.parse(text) as PublishedResult;
    const p = raw.placements[0];
    if (!p) throw new Error('fixture');
    expect(() => serializeResult({ ...raw, placements: [...raw.placements, { ...p, round: 2 }] })).toThrow(/twice/);
  });

  it('application order: canonical, unique, from submission times', () => {
    expect(applicationOrderOf([{ publicId: 'b', submittedAt: '2027-01-02T00:00:00.000Z' }, { publicId: 'c', submittedAt: null }, { publicId: 'a', submittedAt: '2027-01-02T00:00:00.000+00:00' }, { publicId: 'd', submittedAt: '2027-01-01T00:00:00.000Z' }])).toEqual(['d', 'a', 'b', 'c']);
    expect(parseApplicationOrder('["a","b"]').order).toEqual(['a', 'b']);
    expect(() => parseApplicationOrder('["a","a"]')).toThrow(/more than once/);
    expect(() => parseApplicationOrder('[ "a"]')).toThrow(/canonical/);
  });

  it('outcomes round-trip and are validated', () => {
    const o = { computedAt: '2027-01-01T00:00:00.000Z', entries: [{ publicId: 'a1', childRef: 'c1', week: 'W1', ageGroup: 'young', source: 'draw' as const, status: 'accepted' as const }], waitlist: [] };
    expect(parseOutcomes(serializeOutcomes(o))).toEqual(o);
    expect(() => parseOutcomes('{"computedAt":"x","entries":[],"waitlist":[]}')).toThrow(PublishedArtifactError);
  });
});

describe('diffPlanAgainstResult', () => {
  it('names the child, session and what differs', () => {
    const { plan, bundle } = publishedFixture();
    const result = parseResult(bundle.result?.canonical ?? '').result;
    expect(diffPlanAgainstResult(plan, result)).toEqual([]);
    const first = result.placements[0];
    if (!first) throw new Error('fixture');
    const changed = { ...result, placements: [{ ...first, round: first.round + 1 }, ...result.placements.slice(1)], waitlist: result.waitlist.slice(1) };
    const d = diffPlanAgainstResult(plan, changed);
    expect(d.map((x) => x.kind)).toEqual(['placement_changed', 'waitlist_missing']);
    expect(d[0]?.message).toMatch(/round differs/);
  });
});

describe('tamper helpers', () => {
  it('flipHex changes exactly one character', () => {
    expect(flipHex('ab0')).toBe('ab1');
    expect(flipHex('ab1')).toBe('ab0');
  });
});
