import type { DrawPlan } from '../draw/plan.ts';
import type { PublishedResult } from './result.ts';

/**
 * Compares a plan recomputed in the browser with the published result (the
 * placements and waitlist the database committed). Pure. Every difference is
 * reported, in words a non-specialist can follow, with the pseudonymous refs
 * involved; nothing is summarised away.
 */

export type DiscrepancyKind =
  | 'placement_missing'
  | 'placement_unexpected'
  | 'placement_changed'
  | 'waitlist_missing'
  | 'waitlist_unexpected'
  | 'waitlist_changed';

export interface Discrepancy {
  kind: DiscrepancyKind;
  /** Child ref (placements) or "week/ageGroup #position" (waitlist). */
  ref: string;
  message: string;
  replayed: string | null;
  published: string | null;
}

interface Row {
  publicId: string;
  childRef: string;
  week: string;
  ageGroup: string;
  round: number;
}

const short = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);
const describe = (r: Row) => `${r.week} (${r.ageGroup}), round ${String(r.round)}, family ${short(r.publicId)}`;

export function diffPlanAgainstResult(plan: DrawPlan, result: PublishedResult): Discrepancy[] {
  const out: Discrepancy[] = [];
  const replayed = new Map<string, Row>();
  for (const s of plan.steps) {
    for (const p of s.placements) replayed.set(`${p.childRef}\u0000${p.week}`, { publicId: s.publicId, childRef: p.childRef, week: p.week, ageGroup: p.ageGroup, round: s.round });
  }
  const published = new Map(result.placements.map((p) => [`${p.childRef}\u0000${p.week}`, p]));

  for (const [k, r] of replayed) {
    const p = published.get(k);
    if (!p) {
      out.push({
        kind: 'placement_missing',
        ref: r.childRef,
        message: `The replay gives child ${short(r.childRef)} a seat in ${r.week} (${r.ageGroup}), but the published result has no such placement. The database did not commit a seat the algorithm assigned.`,
        replayed: describe(r),
        published: null,
      });
    } else if (p.publicId !== r.publicId || p.ageGroup !== r.ageGroup || p.round !== r.round) {
      const what = [p.publicId !== r.publicId ? 'family' : '', p.ageGroup !== r.ageGroup ? 'age group' : '', p.round !== r.round ? 'round' : ''].filter(Boolean).join(', ');
      out.push({
        kind: 'placement_changed',
        ref: r.childRef,
        message: `Child ${short(r.childRef)} holds ${r.week} in both, but the ${what} differ${what.includes(',') ? '' : 's'}.`,
        replayed: describe(r),
        published: describe(p),
      });
    }
  }
  for (const [k, p] of published) {
    if (replayed.has(k)) continue;
    out.push({
      kind: 'placement_unexpected',
      ref: p.childRef,
      message: `The published result gives child ${short(p.childRef)} a seat in ${p.week} (${p.ageGroup}) that the replay does not assign. The database holds a placement the algorithm did not make.`,
      replayed: null,
      published: describe(p),
    });
  }

  const slot = (w: { week: string; ageGroup: string; position: number }) => `${w.week}/${w.ageGroup} #${String(w.position)}`;
  const who = (w: { publicId: string; childRef: string }) => `child ${short(w.childRef)} (family ${short(w.publicId)})`;
  const replayedWait = new Map(plan.waitlist.map((w) => [slot(w), w]));
  const publishedWait = new Map(result.waitlist.map((w) => [slot(w), w]));
  for (const [k, w] of replayedWait) {
    const p = publishedWait.get(k);
    if (!p) {
      out.push({ kind: 'waitlist_missing', ref: k, message: `The replay puts ${who(w)} at waitlist position ${k}; the published waitlist has nobody there.`, replayed: who(w), published: null });
    } else if (p.childRef !== w.childRef || p.publicId !== w.publicId) {
      out.push({ kind: 'waitlist_changed', ref: k, message: `Waitlist position ${k} holds ${who(p)} in the published result, but ${who(w)} in the replay.`, replayed: who(w), published: who(p) });
    }
  }
  for (const [k, p] of publishedWait) {
    if (!replayedWait.has(k)) out.push({ kind: 'waitlist_unexpected', ref: k, message: `The published waitlist has ${who(p)} at position ${k}, which the replay does not produce.`, replayed: null, published: who(p) });
  }
  return out;
}
