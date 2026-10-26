import type { PLACEMENT_STATUSES } from './schema.ts';

/**
 * Offer lifecycle (Task 11). Pure and SDK-free, shared by the server
 * (functions/shared/offers.ts, which enforces it inside TablesDB transactions)
 * and the browser (labels and which buttons to show).
 *
 *              accept            give back
 *   offered ───────────► accepted ─────────► released
 *   (pending)│                │
 *            │ decline        │ organiser cancels
 *            ├──────► declined└───────────► cancelled
 *            │ 48 h pass
 *            ├──────► expired
 *            │ organiser cancels
 *            └──────► cancelled
 *
 * "offered" is the pending state (the stored value predates Task 11). States
 * are never re-entered, which is what lets the server turn "leave state S"
 * into a unique row (one exit marker per placement and state): a repeated or
 * stale transition fails at commit instead of overwriting a newer one.
 */
export type OfferStatus = (typeof PLACEMENT_STATUSES)[number];

/** Offers expire 48 hours after issuance (Appwrite server clock). */
export const OFFER_TTL_MS = 48 * 3600_000;

export const OFFER_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  offered: ['accepted', 'declined', 'expired', 'cancelled'],
  accepted: ['released', 'cancelled'],
  declined: [],
  expired: [],
  released: [],
  cancelled: [],
};

export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  return OFFER_TRANSITIONS[from].includes(to);
}

/** Every transition except acceptance hands the seat back to the session. */
export const releasesSeat = (to: OfferStatus): boolean => to !== 'accepted';

/** Seats are held by offers in these states. */
export const HOLDING_STATUSES = ['offered', 'accepted'] as const satisfies readonly OfferStatus[];

export type OfferTone = 'neutral' | 'success' | 'pending' | 'danger' | 'info';

export const OFFER_STATUS_TEXT: Readonly<Record<OfferStatus, { label: string; tone: OfferTone }>> = {
  offered: { label: 'Pending reply', tone: 'pending' },
  accepted: { label: 'Accepted', tone: 'success' },
  declined: { label: 'Declined', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'danger' },
  released: { label: 'Given back', tone: 'neutral' },
  cancelled: { label: 'Cancelled by organiser', tone: 'neutral' },
};

/**
 * What a reader should be told at server time `nowMs`. A pending offer past
 * its expiry can no longer be accepted even before the hourly sweep records
 * it as expired, so it is shown as lapsed.
 */
export function displayOfferStatus(status: OfferStatus, expiresAt: string | null | undefined, nowMs: number): OfferStatus | 'lapsed' {
  if (status === 'offered' && expiresAt && Date.parse(expiresAt) <= nowMs) return 'lapsed';
  return status;
}

/** Why a requested transition is refused, written for the person who asked. */
export function refusalMessage(from: OfferStatus, to: OfferStatus): string {
  if (from === 'expired') return 'This offer has expired, so it can no longer be changed.';
  if (from === 'declined') return 'This offer was already declined.';
  if (from === 'cancelled') return 'The organiser cancelled this offer.';
  if (from === 'released') return 'This place was already given back.';
  if (from === 'accepted' && to === 'declined') return 'This place is already accepted. Give it back instead if you no longer need it.';
  if (from === 'offered' && to === 'released') return 'This offer has not been accepted yet. Decline it instead.';
  return `An offer cannot move from "${from}" to "${to}".`;
}
