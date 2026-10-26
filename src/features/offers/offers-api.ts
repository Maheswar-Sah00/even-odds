import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { callFunction } from '../../lib/appwrite/functions.ts';
import type { OfferResponse } from '@shared/offer-input.ts';
import type { OfferStatus } from '@shared/offer-lifecycle.ts';

/** Typed wrappers for the offers area of the api Function. Every check happens server-side. */
export interface OfferView {
  placementId: string;
  week: string;
  weekLabel: string;
  ageGroup: string;
  status: OfferStatus;
  displayStatus: OfferStatus | 'lapsed';
  offeredAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  source: 'draw' | 'waitlist';
  round: number | null;
}

export interface FamilyProgramOffers {
  programId: string;
  name: string;
  timezone: string;
  synthetic: boolean;
  status: string;
  offersIssuedAt: string | null;
  offersSweptAt: string | null;
  offers: (OfferView & { childId: string; childName: string })[];
  waitlist: {
    entryId: string;
    childId: string;
    childName: string;
    week: string;
    weekLabel: string;
    ageGroup: string;
    position: number;
    status: 'waiting' | 'promoted' | 'removed';
    ahead: number | null;
  }[];
}

export interface OrganiserOffersOverview {
  serverTime: string;
  status: string;
  offersIssuedAt: string | null;
  offersSweptAt: string | null;
  sessions: { week: string; weekLabel: string; ageGroup: string; capacity: number; taken: number; pending: number; accepted: number; waiting: number }[];
  offers: (OfferView & { publicId: string; ref: string })[];
  waitlist: {
    entryId: string;
    week: string;
    weekLabel: string;
    ageGroup: string;
    position: number;
    rank: number | null;
    status: 'waiting' | 'promoted' | 'removed';
    publicId: string;
    ref: string;
  }[];
}

export interface SweepResult {
  expired: number;
  skipped: number;
  promoted: number;
  more: boolean;
}

/** A fresh key per intent (crypto.randomUUID without dashes), reused for every retry of that intent. */
export const newIdempotencyKey = () => crypto.randomUUID().replaceAll('-', '');

export const offersApi = (app: BrowserAppwrite) => ({
  mine: (programId?: string) => callFunction<{ serverTime: string; programs: FamilyProgramOffers[] }>(app, 'offers', { action: 'mine', ...(programId ? { programId } : {}) }),
  respond: (programId: string, placementIds: string[], response: OfferResponse, idempotencyKey: string) =>
    callFunction<{ status: 'changed' | 'replayed' | 'unchanged'; offers: OfferView[]; promoted: number }>(app, 'offers', { action: 'respond', programId, placementIds, response, idempotencyKey }),
  overview: (programId: string) => callFunction<OrganiserOffersOverview>(app, 'offers', { action: 'overview', programId }),
  cancel: (programId: string, placementIds: string[], idempotencyKey: string) =>
    callFunction<{ status: 'changed' | 'replayed' | 'unchanged'; cancelled: string[]; promoted: number }>(app, 'offers', { action: 'cancel', programId, placementIds, idempotencyKey }),
  process: (programId: string) => callFunction<SweepResult>(app, 'offers', { action: 'process', programId }),
});

/**
 * Remembers one idempotency key per pending intent, so a retry after a
 * timeout or network error sends the SAME key and can never act twice.
 */
export function intentKeys() {
  const keys = new Map<string, string>();
  return {
    keyFor(intent: string) {
      const existing = keys.get(intent);
      if (existing) return existing;
      const fresh = newIdempotencyKey();
      keys.set(intent, fresh);
      return fresh;
    },
    done(intent: string) {
      keys.delete(intent);
    },
  };
}
