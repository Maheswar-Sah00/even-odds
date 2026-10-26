import { describe, expect, it } from 'vitest';
import { offersRequestSchema } from '../../shared/offer-input.ts';
import { canTransitionOffer, displayOfferStatus, OFFER_TRANSITIONS, OFFER_TTL_MS, refusalMessage, releasesSeat, type OfferStatus } from '../../shared/offer-lifecycle.ts';
import { PLACEMENT_STATUSES } from '../../shared/schema.ts';

describe('offer lifecycle', () => {
  it('covers every stored status, and only pending and accepted offers can move', () => {
    expect(Object.keys(OFFER_TRANSITIONS).sort()).toEqual([...PLACEMENT_STATUSES].sort());
    expect(OFFER_TRANSITIONS.offered).toEqual(['accepted', 'declined', 'expired', 'cancelled']);
    expect(OFFER_TRANSITIONS.accepted).toEqual(['released', 'cancelled']);
    for (const s of ['declined', 'expired', 'released', 'cancelled'] as const) expect(OFFER_TRANSITIONS[s]).toEqual([]);
  });

  it('never re-enters a state (each state is left at most once, so exit markers are sound)', () => {
    const reachable = (from: OfferStatus, seen = new Set<OfferStatus>()): Set<OfferStatus> => {
      for (const to of OFFER_TRANSITIONS[from]) {
        expect(seen.has(to) || to === from, `${from} -> ${to} revisits a state`).toBe(false);
        reachable(to, new Set([...seen, from]));
      }
      return seen;
    };
    for (const s of PLACEMENT_STATUSES) reachable(s);
  });

  it('refuses invalid and repeated transitions', () => {
    expect(canTransitionOffer('offered', 'accepted')).toBe(true);
    expect(canTransitionOffer('accepted', 'accepted')).toBe(false);
    expect(canTransitionOffer('accepted', 'declined')).toBe(false);
    expect(canTransitionOffer('expired', 'accepted')).toBe(false);
    expect(canTransitionOffer('offered', 'released')).toBe(false);
    expect(refusalMessage('accepted', 'declined')).toMatch(/Give it back/);
    expect(refusalMessage('expired', 'accepted')).toMatch(/expired/);
  });

  it('releases a seat on every transition except acceptance', () => {
    expect(releasesSeat('accepted')).toBe(false);
    for (const s of ['declined', 'expired', 'released', 'cancelled'] as const) expect(releasesSeat(s)).toBe(true);
  });

  it('shows a pending offer past its expiry as lapsed, before the sweep records it', () => {
    const at = Date.parse('2027-07-01T12:00:00.000Z');
    expect(OFFER_TTL_MS).toBe(48 * 3600_000);
    expect(displayOfferStatus('offered', '2027-07-01T12:00:00.000Z', at)).toBe('lapsed');
    expect(displayOfferStatus('offered', '2027-07-01T12:00:01.000Z', at)).toBe('offered');
    expect(displayOfferStatus('accepted', '2027-07-01T11:00:00.000Z', at)).toBe('accepted');
  });
});

describe('offer requests', () => {
  it('requires an idempotency key and bounded placement lists', () => {
    const ok = { action: 'respond', programId: 'p1', placementIds: ['a'], response: 'accept', idempotencyKey: 'k'.repeat(32) };
    expect(offersRequestSchema.safeParse(ok).success).toBe(true);
    expect(offersRequestSchema.safeParse({ ...ok, idempotencyKey: 'short' }).success).toBe(false);
    expect(offersRequestSchema.safeParse({ ...ok, placementIds: [] }).success).toBe(false);
    expect(offersRequestSchema.safeParse({ ...ok, response: 'expire' }).success).toBe(false);
    expect(offersRequestSchema.safeParse({ action: 'cancel', programId: 'p1', placementIds: ['a'] }).success).toBe(false);
  });
});
