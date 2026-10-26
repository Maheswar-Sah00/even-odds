import { auditIntegrity, type AuditEntry, type AuditIntegrity } from '../audit-chain.ts';
import { computePlan, planHash, type DrawInputs, type DrawPlan } from '../draw/plan.ts';
import { FrozenInputsError, frozenInputsHash, parseFrozenInputs, summarizeFrozenInputs } from '../freeze/canonical.ts';
import { announcedRound, deriveSeed, DRAND_CHAIN, freezeDeadlineMs, roundTimeMs, SEED_SCHEME, timingOf, verifyBeacon, type BeaconFetch, type BeaconRecord } from '../freeze/drand.ts';
import type { ReplayBundle } from './bundle.ts';
import { diffPlanAgainstResult, type Discrepancy } from './diff.ts';
import { applicationOrderProblems, parseApplicationOrder, parseOutcomes, parseResult, PublishedArtifactError, type PublishedResult, type ResultOutcomes } from './result.ts';

/**
 * The independent replay (Task 13, docs/REPLAY.md). Pure apart from the
 * injectable beacon fetch: every check is recomputed here from the raw public
 * artifacts in a ReplayBundle, with the same shared code the server ran. No
 * server-provided verdict is read; a value the server recorded is only ever
 * something to COMPARE against.
 *
 * Steps run in protocol order. A step that cannot run yet is "pending"; one
 * whose prerequisite failed is "skipped"; nothing is reported as passing
 * unless this code computed it.
 */

export type StepStatus = 'pass' | 'fail' | 'pending' | 'skipped';
export type StepKey = 'audit' | 'announced' | 'inputs' | 'inputs_hash' | 'order' | 'timing' | 'beacon' | 'seed' | 'plan' | 'result' | 'compare';

export interface ReplayStep {
  key: StepKey;
  title: string;
  status: StepStatus;
  /** One sentence, plain language. */
  summary: string;
  /** Each problem (or supporting fact) on its own line. */
  details: string[];
}

export interface BeaconUsed {
  beacon: BeaconRecord;
  source: string;
}

export interface Verification {
  steps: ReplayStep[];
  audit: AuditIntegrity;
  /** Each artifact is set only when its own checks passed (and the audit log is intact). */
  inputs: DrawInputs | null;
  canonical: string | null;
  inputsHash: string | null;
  applicationOrder: { order: string[]; committedAtFreeze: true } | null;
  beacon: BeaconUsed | null;
  seed: string | null;
  plan: DrawPlan | null;
  planHash: string | null;
  result: PublishedResult | null;
  /** Live offer and waitlist status beside the result: NOT hashed, the server's word about events after the draw. */
  outcomes: ResultOutcomes | null;
  discrepancies: Discrepancy[];
  /** null = not compared against a trusted result (no plan or verified result yet, or the audit log is broken). */
  replayMatches: boolean | null;
}

export interface ReplayOptions {
  now?: number;
  /**
   * Fetches the beacon when the bundle carries none (the browser asks drand
   * directly). If it fails, the server's stored copy is verified instead: the
   * BLS signature is checked here either way, so the copy cannot be forged.
   */
  fetchBeacon?: (round: number) => Promise<BeaconFetch>;
}

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 12)}…` : 'none');
const TITLES: Record<StepKey, string> = {
  audit: 'Audit log integrity',
  announced: 'drand round announced in advance',
  inputs: 'Frozen public inputs',
  inputs_hash: 'Canonical inputs hash',
  order: 'Application order committed at freeze',
  timing: 'Frozen before the round existed',
  beacon: 'drand beacon signature',
  seed: 'Draw seed',
  plan: 'Lottery replayed in this browser',
  result: 'Published result file',
  compare: 'Replayed placements vs published result',
};

/** The first parsable payload of `event` in the log (the integrity step reports whether the log itself is sound). */
function payloadOf(audit: readonly unknown[], event: string): Record<string, unknown> | null {
  const entries = audit.filter((a): a is AuditEntry => typeof a === 'object' && a !== null && (a as AuditEntry).event === event && typeof (a as AuditEntry).payload === 'string');
  for (const e of [...entries].sort((x, y) => x.seq - y.seq)) {
    try {
      return JSON.parse(e.payload) as Record<string, unknown>;
    } catch {
      // Reported by the integrity step.
    }
  }
  return null;
}

/** "label: expected X, found Y" for every source that disagrees with the recomputed value. */
function mismatches(computed: string, sources: [string, unknown][]): string[] {
  return sources.filter(([, v]) => v !== undefined && v !== null && v !== computed).map(([label, v]) => `${label} says ${short(typeof v === 'string' ? v : JSON.stringify(v))}, but this browser computed ${short(computed)}.`);
}

export async function replayBundle(bundle: ReplayBundle, opts: ReplayOptions = {}): Promise<Verification> {
  const now = opts.now ?? Date.now();
  const steps: ReplayStep[] = [];
  const add = (key: StepKey, status: StepStatus, summary: string, details: string[] = []) => {
    steps.push({ key, title: TITLES[key], status, summary, details });
  };
  const skipRest = (from: StepKey[], why: string) => {
    for (const k of from) if (!steps.some((s) => s.key === k)) add(k, 'skipped', why);
  };
  const { program, snapshot, run } = bundle;
  const audit = auditIntegrity(bundle.audit);
  const v: Verification = { steps, audit, inputs: null, canonical: null, inputsHash: null, applicationOrder: null, beacon: null, seed: null, plan: null, planHash: null, result: null, outcomes: null, discrepancies: [], replayMatches: null };
  const ev = (event: string) => payloadOf(bundle.audit, event);

  // 1. Audit log: every record, plus the events the other artifacts imply must exist.
  const required: [boolean, string, string][] = [
    [snapshot !== null, 'inputs_frozen', 'the inputs are frozen'],
    [Boolean(run?.seed), 'beacon_verified', 'the run has a seed'],
    [run?.status === 'completed', 'draw_completed', 'the draw completed'],
    [bundle.result !== null, 'result_published', 'a result file is published'],
  ];
  const missingEvents = required.filter(([needed, event]) => needed && !ev(event)).map(([, event, why]) => `There is no "${event}" entry although ${why}: entries may have been cut off the end of the log or never written.`);
  const auditDetails = [...audit.issues.map((i) => i.message), ...missingEvents];
  add(
    'audit',
    auditDetails.length === 0 ? 'pass' : 'fail',
    auditDetails.length === 0
      ? `${String(audit.records)} entries; every payload matches its hash and every entry links to the one before it. Chain head ${short(audit.head)}.`
      : `${String(auditDetails.length)} problem(s) found in ${String(audit.records)} records; ${String(audit.verified)} entries check out.`,
    auditDetails,
  );
  const auditOk = auditDetails.length === 0;

  // 2. Round announced before applications closed.
  const profile = timingOf(program);
  const announcement = ev('program_published')?.drand_round ?? ev('drand_round_announced')?.drand_round;
  if (program.drandRound) {
    const rule = announcedRound(program.windowClose, profile);
    const problems = [
      program.drandRound !== rule ? `The program uses round ${String(program.drandRound)}, but the announcement rule gives round ${String(rule)} for its closing time.` : '',
      program.drandChain !== DRAND_CHAIN.hash ? 'The program names a drand chain other than the pinned quicknet chain.' : '',
      announcement !== program.drandRound ? `The audit log announces round ${typeof announcement === 'number' ? String(announcement) : 'none'}, not ${String(program.drandRound)}.` : '',
      snapshot && snapshot.drandRound !== program.drandRound ? `The frozen snapshot names round ${String(snapshot.drandRound)}.` : '',
      run && run.drandRound !== program.drandRound ? `The draw run names round ${String(run.drandRound)}.` : '',
    ].filter(Boolean);
    const when = profile === 'demo' ? 'logged when this demo sandbox was fast-forwarded to its close, before the freeze (demo timing: round due 45 s after the close)' : 'logged when the program was published';
    add('announced', problems.length ? 'fail' : 'pass', problems.length ? 'The round does not follow the pre-announcement rule.' : `Round ${String(program.drandRound)} on the quicknet chain, due ${new Date(roundTimeMs(program.drandRound)).toISOString()}, ${when}.`, problems);
  } else {
    add('announced', 'pending', 'No round has been announced yet.');
  }

  // 3-4. Inputs: inspect, then recompute the hash.
  if (!snapshot) {
    add('inputs', 'pending', 'Inputs are frozen when applications close.');
    skipRest(['inputs_hash', 'order', 'timing', 'beacon', 'seed', 'plan', 'result', 'compare'], 'Waiting for the freeze.');
    return v;
  }
  let inputs: DrawInputs;
  try {
    inputs = parseFrozenInputs(snapshot.canonical).inputs;
  } catch (err) {
    const problems = err instanceof FrozenInputsError ? err.problems : [err instanceof Error ? err.message : String(err)];
    add('inputs', 'fail', 'The published inputs file is not a valid canonical inputs file, so it cannot be the file that was hashed.', problems);
    skipRest(['inputs_hash', 'order', 'timing', 'beacon', 'seed', 'plan', 'result', 'compare'], 'The inputs file is invalid.');
    return v;
  }
  const s = summarizeFrozenInputs(inputs);
  const c = snapshot.counts;
  const countProblems = [
    s.applications !== c.applications ? `applications: file has ${String(s.applications)}, published count ${String(c.applications)}` : '',
    s.children !== c.children ? `children: file has ${String(s.children)}, published count ${String(c.children)}` : '',
    s.sessions !== c.sessions ? `sessions: file has ${String(s.sessions)}, published count ${String(c.sessions)}` : '',
    s.seats !== c.seats ? `seats: file has ${String(s.seats)}, published count ${String(c.seats)}` : '',
    s.overrides !== c.overrides || JSON.stringify(s.overrideCounts) !== c.overrideCounts ? 'override counts differ from the published counts' : '',
  ].filter(Boolean);
  add(
    'inputs',
    countProblems.length ? 'fail' : 'pass',
    countProblems.length
      ? 'The inputs file does not match the published record counts.'
      : `Canonical and pseudonymous: ${String(s.applications)} applications, ${String(s.children)} children, ${String(s.sessions)} sessions (${String(s.seats)} seats), ${String(s.overrides)} overrides. No names, birthdates, addresses, guardians or child keys: the format has no field for them.`,
    countProblems,
  );

  const computedInputsHash = frozenInputsHash(snapshot.canonical);
  const loggedFreeze = ev('inputs_frozen');
  const hashProblems = mismatches(computedInputsHash, [
    ['The snapshot', snapshot.inputsHash],
    ['The program', program.inputsHash],
    ['The audit log (inputs_frozen)', loggedFreeze?.inputs_hash],
    ['The draw run', run?.inputsHash],
  ]);
  if (!loggedFreeze?.inputs_hash) hashProblems.push('The audit log has no inputs_frozen entry with an inputs hash to compare against.');
  add('inputs_hash', hashProblems.length ? 'fail' : 'pass', hashProblems.length ? `SHA-256 of the published file is ${short(computedInputsHash)}, which does not match every published copy of the hash.` : `SHA-256 of the published canonical file is ${short(computedInputsHash)}, matching the program, the snapshot, the draw run and the audit log; counts recomputed.`, hashProblems);
  if (hashProblems.length || countProblems.length) {
    skipRest(['order', 'timing', 'beacon', 'seed', 'plan', 'result', 'compare'], 'The inputs do not match their published hash.');
    return v;
  }
  if (auditOk) {
    v.inputs = inputs;
    v.canonical = snapshot.canonical;
    v.inputsHash = computedInputsHash;
  }

  // 5. Application order (not a draw input; for the fairness report).
  if (snapshot.applicationOrder === null) {
    add('order', 'skipped', 'This program was frozen before the application order was committed, so no order was fixed before the draw.');
  } else {
    try {
      const { order, hash } = parseApplicationOrder(snapshot.applicationOrder);
      const problems = [...mismatches(hash, [['The snapshot', snapshot.applicationOrderHash], ['The audit log (inputs_frozen)', loggedFreeze?.application_order_hash]]), ...applicationOrderProblems(order, inputs.applications.map((a) => a.publicId))];
      if (!loggedFreeze?.application_order_hash) problems.push('The inputs_frozen audit entry does not record the application order hash.');
      add('order', problems.length ? 'fail' : 'pass', problems.length ? 'The application order does not match what was committed at freeze.' : `${String(order.length)} applications in submission order (no timestamps), hash ${short(hash)} logged at freeze. Not used by the lottery.`, problems);
      if (!problems.length && auditOk) v.applicationOrder = { order, committedAtFreeze: true };
    } catch (err) {
      add('order', 'fail', 'The application order file is not valid.', err instanceof PublishedArtifactError ? err.problems : [String(err)]);
    }
  }

  // 6. Freeze timing (server clock, trusted).
  const frozenAt = Date.parse(snapshot.frozenAt);
  const deadline = freezeDeadlineMs(snapshot.drandRound, profile);
  add(
    'timing',
    frozenAt <= deadline ? 'pass' : 'fail',
    `Frozen ${new Date(frozenAt).toISOString()} (server time, trusted); round due ${new Date(roundTimeMs(snapshot.drandRound)).toISOString()}.`,
    frozenAt <= deadline ? [] : [`The freeze is after the deadline ${new Date(deadline).toISOString()}: the inputs may have been fixed after the random value could be known.`],
  );

  // 7. Beacon: verified here, against the pinned key, whatever its source.
  const round = snapshot.drandRound;
  if (now < roundTimeMs(round)) {
    add('beacon', 'pending', `Round ${String(round)} has not been produced yet.`);
    skipRest(['seed', 'plan', 'result', 'compare'], 'Waiting for the drand round.');
    return v;
  }
  let candidate: { raw: unknown; source: string } | null = bundle.beacon ? { raw: { round: bundle.beacon.round, randomness: bundle.beacon.randomness, signature: bundle.beacon.signature }, source: bundle.beacon.source } : null;
  const notes: string[] = [];
  if (!candidate && opts.fetchBeacon) {
    const fetched = await opts.fetchBeacon(round);
    if (fetched.status === 'ok') candidate = { raw: fetched.beacon, source: fetched.relay };
    else notes.push(`drand could not be reached from this browser (${fetched.detail}).`);
  }
  if (!candidate && run?.beaconRandomness && run.beaconSignature) {
    candidate = { raw: { round: run.drandRound, randomness: run.beaconRandomness, signature: run.beaconSignature }, source: 'server copy' };
    notes.push('Verifying the server\'s stored copy instead; its BLS signature is checked here, so it cannot have been forged.');
  }
  if (!candidate) {
    add('beacon', 'pending', 'No beacon to verify yet.', notes);
    skipRest(['seed', 'plan', 'result', 'compare'], 'Waiting for the beacon.');
    return v;
  }
  const check = await verifyBeacon(candidate.raw, round);
  if (!check.ok) {
    add('beacon', 'fail', `The beacon (${candidate.source}) does not verify for round ${String(round)}: it was not produced by drand.`, [...notes, check.reason]);
    skipRest(['seed', 'plan', 'result', 'compare'], 'The beacon did not verify.');
    return v;
  }
  const loggedBeacon = ev('beacon_verified');
  const beaconProblems = [
    ...mismatches(check.beacon.randomness, [['The draw run\'s stored randomness', run?.beaconRandomness], ['The audit log (beacon_verified) randomness', loggedBeacon?.randomness]]),
    run?.beaconSignature && run.beaconSignature !== check.beacon.signature ? 'The draw run stores a different signature than the verified beacon.' : '',
  ].filter(Boolean);
  v.beacon = { beacon: check.beacon, source: candidate.source };
  const where = candidate.source === 'server copy' ? 'the server\'s stored copy' : candidate.source.startsWith('http') ? `fetched from ${candidate.source} by this browser` : `from ${candidate.source}`;
  add('beacon', beaconProblems.length ? 'fail' : 'pass', beaconProblems.length ? 'drand\'s value differs from the one the server recorded.' : `Round ${String(round)}, ${where}; BLS signature verified against the pinned quicknet key.`, [...notes, ...beaconProblems]);
  if (beaconProblems.length) {
    skipRest(['seed', 'plan', 'result', 'compare'], 'The server used a different beacon.');
    return v;
  }

  // 8. Seed.
  const seed = deriveSeed({ chainHash: DRAND_CHAIN.hash, round, randomness: check.beacon.randomness, inputsHash: computedInputsHash, programId: program.id });
  v.seed = seed;
  const seedProblems = mismatches(seed, [['The draw run', run?.seed], ['The audit log (beacon_verified)', loggedBeacon?.seed]]);
  if (run?.seedScheme && run.seedScheme !== SEED_SCHEME) seedProblems.push(`The run declares seed scheme "${run.seedScheme}", not ${SEED_SCHEME}.`);
  if (!run?.seed) add('seed', 'pending', `Derived here: ${short(seed)}. The server has not recorded its seed yet.`);
  else add('seed', seedProblems.length ? 'fail' : 'pass', seedProblems.length ? 'The server\'s seed is not the one the beacon and the inputs give.' : `${short(seed)}, derived here from the beacon and the inputs hash (${SEED_SCHEME}).`, seedProblems);
  if (seedProblems.length) {
    skipRest(['plan', 'result', 'compare'], 'The seed does not match.');
    return v;
  }

  // 9. Replay the lottery with the shared draw module.
  const plan = computePlan(inputs, seed);
  const hash = planHash(plan);
  v.plan = plan;
  v.planHash = hash;
  const loggedDraw = ev('draw_completed');
  if (run?.status === 'failed') {
    add('plan', 'fail', `Recomputed here (${String(plan.summary.placements)} placements), but the server's draw stopped at step ${String(run.cursor)}.`, [run.error ?? 'No reason recorded.']);
  } else if (run?.status === 'completed') {
    const planProblems = mismatches(hash, [['The draw run', run.planHash], ['The audit log (draw_completed)', loggedDraw?.plan_hash]]);
    add('plan', planProblems.length ? 'fail' : 'pass', planProblems.length ? 'The plan computed here differs from the plan the server recorded.' : `Recomputed here: ${String(plan.summary.placements)} placements, plan hash ${short(hash)} matches the draw.`, planProblems);
  } else {
    add('plan', 'pending', `Recomputed here (${String(plan.summary.placements)} placements, hash ${short(hash)}); the draw has not completed yet.`);
  }

  // 10. The published result: what the database committed.
  if (!bundle.result) {
    add('result', 'pending', run?.status === 'completed' ? 'The server has not published the committed placements yet.' : 'The result is published after the draw completes.');
    skipRest(['compare'], 'No published result yet.');
    return v;
  }
  let result: PublishedResult;
  let resultHash: string;
  try {
    ({ result, hash: resultHash } = parseResult(bundle.result.canonical));
  } catch (err) {
    add('result', 'fail', 'The published result file is not a valid canonical result file.', err instanceof PublishedArtifactError ? err.problems : [String(err)]);
    skipRest(['compare'], 'The result file is invalid.');
    return v;
  }
  const loggedResult = ev('result_published');
  const resultProblems = [
    ...mismatches(resultHash, [['The result row', bundle.result.resultHash], ['The audit log (result_published)', loggedResult?.result_hash]]),
    loggedResult ? '' : 'The audit log has no result_published entry.',
    result.programId !== program.id ? `The result is for program ${result.programId}.` : '',
    result.inputsHash !== computedInputsHash ? `The result was drawn from inputs ${short(result.inputsHash)}, not the frozen inputs ${short(computedInputsHash)}.` : '',
    run && result.drawRunId !== run.id ? 'The result names a different draw run.' : '',
    result.placements.length !== bundle.result.placements || result.waitlist.length !== bundle.result.waitlist ? 'The published counts do not match the file.' : '',
  ].filter(Boolean);
  add('result', resultProblems.length ? 'fail' : 'pass', resultProblems.length ? 'The result file does not match its published hash or the frozen inputs.' : `${String(result.placements.length)} committed placements and ${String(result.waitlist.length)} waitlist entries; SHA-256 ${short(resultHash)} matches the row and the audit log.`, resultProblems);
  if (resultProblems.length) {
    skipRest(['compare'], 'The result file cannot be trusted.');
    return v;
  }
  if (auditOk) {
    v.result = result;
    if (bundle.result.outcomes) {
      try {
        v.outcomes = parseOutcomes(bundle.result.outcomes);
      } catch {
        v.outcomes = null;
      }
    }
  }

  // 11. Placement by placement.
  const discrepancies = diffPlanAgainstResult(plan, result);
  if (result.planHash !== hash) discrepancies.unshift({ kind: 'placement_changed', ref: 'plan', message: `The result records plan hash ${short(result.planHash)}, but the replay gives ${short(hash)}.`, replayed: hash, published: result.planHash });
  v.discrepancies = discrepancies;
  // Only a result anchored in an intact audit log counts as "the published result".
  v.replayMatches = auditOk ? discrepancies.length === 0 : null;
  add(
    'compare',
    discrepancies.length ? 'fail' : 'pass',
    discrepancies.length ? `${String(discrepancies.length)} difference(s) between the replay and what the database committed.` : `All ${String(result.placements.length)} placements and ${String(result.waitlist.length)} waitlist positions committed by the database are exactly the ones replayed here.`,
    discrepancies.map((d) => d.message),
  );
  return v;
}
