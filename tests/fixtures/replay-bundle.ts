import { entryHash, GENESIS_HASH, type AuditEntry } from '../../shared/audit-chain.ts';
import { canonicalJson, computePlan, planHash, type DrawPlan } from '../../shared/draw/index.ts';
import { SAMPLE_INPUTS } from '../../shared/draw/sample.ts';
import { frozenInputsHash, serializeFrozenInputs, summarizeFrozenInputs } from '../../shared/freeze/canonical.ts';
import { deriveSeed, DRAND_CHAIN, roundTimeMs, ROUND_DELAY_MS, SEED_SCHEME } from '../../shared/freeze/drand.ts';
import { sha256Hex } from '../../shared/draw/sha256.ts';
import { BUNDLE_FORMAT, type ReplayBundle } from '../../shared/replay/bundle.ts';
import { artifactHash, RESULT_FORMAT, serializeApplicationOrder, serializeResult, type PublishedResult } from '../../shared/replay/result.ts';
import { QUICKNET_1000000 } from './drand-beacons.ts';

/**
 * SYNTHETIC published draw, shaped exactly like what the server publishes:
 * the sample inputs, frozen for the REAL quicknet round 1,000,000 (whose
 * beacon is stored in drand-beacons.ts), drawn, and the result committed as
 * planned. Every hash and audit entry is computed, none is typed in.
 */

export const ROUND = QUICKNET_1000000.round;
export const ROUND_AT = roundTimeMs(ROUND);

const audit = (events: [string, Record<string, unknown>][]): AuditEntry[] => {
  let prev = GENESIS_HASH;
  return events.map(([event, payload], i) => {
    const text = canonicalJson(payload);
    const payloadHash = sha256Hex(text);
    const e = { seq: i + 1, event, payload: text, payload_hash: payloadHash, prev_hash: prev, entry_hash: entryHash(prev, i + 1, event, payloadHash) };
    prev = e.entry_hash;
    return e;
  });
};

export interface PublishedFixture {
  bundle: ReplayBundle;
  plan: DrawPlan;
  seed: string;
}

/** `result` lets a test publish a result that differs from the plan but is consistently hashed and logged (a database that diverged). */
export function publishedFixture(opts: { result?: (r: PublishedResult) => PublishedResult; withBeacon?: boolean; applicationOrder?: string[] | null } = {}): PublishedFixture {
  const canonical = serializeFrozenInputs(SAMPLE_INPUTS);
  const inputsHash = frozenInputsHash(canonical);
  const programId = SAMPLE_INPUTS.programId;
  const seed = deriveSeed({ chainHash: DRAND_CHAIN.hash, round: ROUND, randomness: QUICKNET_1000000.randomness, inputsHash, programId });
  const plan = computePlan(SAMPLE_INPUTS, seed);
  const hash = planHash(plan);
  const drawRunId = 'drsample';
  const planned: PublishedResult = {
    format: RESULT_FORMAT,
    programId,
    drawRunId,
    inputsHash,
    planHash: hash,
    placements: plan.steps.flatMap((s) => s.placements.map((p) => ({ publicId: s.publicId, childRef: p.childRef, week: p.week, ageGroup: p.ageGroup, round: s.round }))),
    waitlist: plan.waitlist.map((w) => ({ week: w.week, ageGroup: w.ageGroup, position: w.position, publicId: w.publicId, childRef: w.childRef })),
  };
  const resultText = serializeResult(opts.result ? opts.result(planned) : planned);
  const result = JSON.parse(resultText) as PublishedResult;
  const resultHash = artifactHash(resultText);
  const order = opts.applicationOrder === undefined ? SAMPLE_INPUTS.applications.map((a) => a.publicId) : opts.applicationOrder;
  const orderText = order ? serializeApplicationOrder(order) : null;
  const orderHash = orderText ? artifactHash(orderText) : null;
  const summary = summarizeFrozenInputs(SAMPLE_INPUTS);
  const windowClose = new Date(ROUND_AT - ROUND_DELAY_MS).toISOString();
  const frozenAt = new Date(ROUND_AT - 2 * 3600_000).toISOString();

  const bundle: ReplayBundle = {
    format: BUNDLE_FORMAT,
    exportedAt: '2026-10-25T00:00:00.000Z',
    program: { id: programId, namespace: null, status: 'drawn', windowClose, drandRound: ROUND, drandChain: DRAND_CHAIN.hash, inputsHash },
    snapshot: {
      canonical,
      inputsHash,
      frozenAt,
      drandRound: ROUND,
      drandChain: DRAND_CHAIN.hash,
      counts: { applications: summary.applications, children: summary.children, sessions: summary.sessions, seats: summary.seats, overrides: summary.overrides, overrideCounts: JSON.stringify(summary.overrideCounts) },
      applicationOrder: orderText,
      applicationOrderHash: orderHash,
    },
    run: {
      id: drawRunId,
      status: 'completed',
      drandRound: ROUND,
      inputsHash,
      seedScheme: SEED_SCHEME,
      seed,
      planHash: hash,
      beaconRandomness: QUICKNET_1000000.randomness,
      beaconSignature: QUICKNET_1000000.signature,
      cursor: plan.steps.length,
      error: null,
    },
    beacon: opts.withBeacon === false ? null : { ...QUICKNET_1000000, source: 'https://api.drand.sh' },
    result: { canonical: resultText, resultHash, drawRunId, placements: result.placements.length, waitlist: result.waitlist.length, outcomes: null, outcomesAt: null },
    audit: audit([
      ['program_published', { drand_chain: DRAND_CHAIN.hash, drand_round: ROUND }],
      ['inputs_frozen', { inputs_hash: inputsHash, frozen_at: frozenAt, drand_round: ROUND, ...(orderHash ? { application_order_hash: orderHash } : {}) }],
      ['beacon_verified', { draw_run_id: drawRunId, drand_round: ROUND, randomness: QUICKNET_1000000.randomness, signature: QUICKNET_1000000.signature, seed, inputs_hash: inputsHash }],
      ['draw_completed', { draw_run_id: drawRunId, inputs_hash: inputsHash, seed, plan_hash: hash }],
      ['result_published', { format: RESULT_FORMAT, result_hash: resultHash, draw_run_id: drawRunId, inputs_hash: inputsHash, plan_hash: hash, placements: result.placements.length, waitlist: result.waitlist.length }],
    ]),
  };
  return { bundle, plan, seed };
}
