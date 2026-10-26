import { canonicalJson, type DrawInputs } from '../draw/plan.ts';
import type { ReplayBundle } from './bundle.ts';
import type { PublishedResult } from './result.ts';

/**
 * Deliberate modifications for the replay page's "try to break it" panel and
 * for the tests: each returns a COPY of the bundle with one published artifact
 * changed the way a dishonest operator (or a corrupted copy) might change it.
 * Verification of the copy must then fail at the step named in TAMPERS.
 */

/** Flips the last hex digit of a hash-like string. */
export const flipHex = (h: string): string => (h.length === 0 ? h : h.slice(0, -1) + (h.endsWith('0') ? '1' : '0'));

const clone = (b: ReplayBundle): ReplayBundle => JSON.parse(JSON.stringify(b)) as ReplayBundle;

export type TamperKey = 'inputs' | 'inputs_hash' | 'beacon' | 'result' | 'audit';

export const TAMPERS: Record<TamperKey, { label: string; description: string; failsAt: string }> = {
  inputs: { label: 'Raise one family\'s priority', description: 'Changes the first application\'s tier in the frozen inputs (still a well-formed canonical file).', failsAt: 'inputs_hash' },
  inputs_hash: { label: 'Change the published inputs hash', description: 'Flips one hex digit of the hash the snapshot publishes.', failsAt: 'inputs_hash' },
  beacon: { label: 'Swap in other randomness', description: 'Flips one hex digit of the drand beacon\'s randomness.', failsAt: 'beacon' },
  result: { label: 'Move a placement', description: 'Moves the first committed placement to another week in the published result.', failsAt: 'result' },
  audit: { label: 'Edit an audit entry', description: 'Rewrites the payload of the first audit entry.', failsAt: 'audit' },
};

export function tamper(bundle: ReplayBundle, key: TamperKey): ReplayBundle {
  const b = clone(bundle);
  switch (key) {
    case 'inputs': {
      if (!b.snapshot) break;
      const inputs = JSON.parse(b.snapshot.canonical) as DrawInputs;
      const first = inputs.applications[0];
      if (first) first.tier = first.tier === 0 ? 1 : 0;
      b.snapshot.canonical = canonicalJson(inputs);
      break;
    }
    case 'inputs_hash':
      if (b.snapshot) b.snapshot.inputsHash = flipHex(b.snapshot.inputsHash);
      break;
    case 'beacon': {
      const source = b.beacon ?? (b.run?.beaconRandomness && b.run.beaconSignature ? { round: b.run.drandRound, randomness: b.run.beaconRandomness, signature: b.run.beaconSignature, source: 'server copy' } : null);
      if (source) b.beacon = { ...source, randomness: flipHex(source.randomness), source: `${source.source}, modified` };
      break;
    }
    case 'result': {
      if (!b.result) break;
      const r = JSON.parse(b.result.canonical) as PublishedResult;
      const first = r.placements[0];
      const other = r.placements.find((p) => first && p.week !== first.week);
      if (first) first.week = other?.week ?? `${first.week}x`;
      b.result.canonical = canonicalJson({ ...r, placements: [...r.placements].sort((x, y) => (`${x.childRef}\u0000${x.week}` < `${y.childRef}\u0000${y.week}` ? -1 : 1)) });
      break;
    }
    case 'audit': {
      const first = b.audit[0] as { payload?: string } | undefined;
      if (first && typeof first.payload === 'string') first.payload = first.payload.replace(/\d/, (d) => String((Number(d) + 1) % 10)) + (/\d/.test(first.payload) ? '' : ' ');
      break;
    }
  }
  return b;
}

/** Whether a tamper can apply to this bundle (e.g. no result to move before the draw). */
export function canTamper(bundle: ReplayBundle, key: TamperKey): boolean {
  switch (key) {
    case 'inputs':
    case 'inputs_hash':
      return bundle.snapshot !== null;
    case 'beacon':
      return bundle.beacon !== null || Boolean(bundle.run?.beaconRandomness);
    case 'result':
      return bundle.result !== null;
    case 'audit':
      return bundle.audit.length > 0;
  }
}
