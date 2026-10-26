import type { ConsoleCommand, OverrideReason, VerificationReason } from '@shared/console-input.ts';
import type { DemoRequest } from '@shared/demo-input.ts';
import type { FairnessReport } from '@shared/fairness.ts';
import type { Classification, LngLat } from '@shared/geo.ts';
import type { OfferResponse } from '@shared/offer-input.ts';
import type { OfferStatus } from '@shared/offer-lifecycle.ts';
import type { BrowserAppwrite } from '../../lib/appwrite/client.ts';
import { callFunction } from '../../lib/appwrite/functions.ts';
import type { OrganiserOffersOverview, SweepResult } from '../offers/offers-api.ts';

/**
 * The organiser console talks to ONE interface. Production programs go to
 * the api "console" area (organiser Team re-checked server-side); the judge
 * sandbox goes to the "demo" area, which never takes a program ID and only
 * ever acts on the caller's own demo program. Same commands, same server
 * code (functions/shared/console.ts); only the authorisation differs.
 */
export interface ConsoleApi {
  scope: 'production' | 'demo';
  command: <T>(command: ConsoleCommand) => Promise<T>;
  /** Freeze is a console action in production; in the sandbox it is part of "fast-forward to the close". */
  freeze?: () => Promise<unknown>;
  classifyPoint?: (point: LngLat) => Promise<Classification>;
}

export const productionConsoleApi = (app: BrowserAppwrite, programId: string): ConsoleApi => ({
  scope: 'production',
  command: <T,>(command: ConsoleCommand) => callFunction<T>(app, 'console', { action: command.action, programId, command }),
  freeze: () => callFunction(app, 'organiser', { action: 'freeze', programId }),
  classifyPoint: (point) => callFunction<Classification>(app, 'organiser', { action: 'classifyPoint', programId, point }),
});

export const demoConsoleApi = (app: BrowserAppwrite): ConsoleApi => ({
  scope: 'demo',
  command: <T,>(command: ConsoleCommand) => callFunction<T>(app, 'demo', { action: 'console', command }),
});

// ---- response shapes (the server is authoritative; these describe what it returns) ----

export interface DemandReport {
  applications: number;
  late: number;
  children: number;
  weeksRequested: number;
  seats: number;
  oversubscribed: number;
  sessions: { ledgerId: string; week: string; weekLabel: string; ageGroup: string; capacity: number; taken: number; firstChoice: number; ranked: number; perSeat: number | null; oversubscribed: boolean }[];
}

export interface VerificationItem {
  publicId: string;
  claimedTier: number;
  verifiedTier: number | null;
  effectiveTier: number;
  priorityClaim: boolean;
  nearBoundary: boolean;
  children: number;
  late: boolean;
  state: 'unverified' | 'confirmed' | 'changed';
}

export interface VerificationQueue {
  locked: boolean;
  tierLabels: Record<string, string>;
  defaultTier: number;
  needsReview: number;
  items: VerificationItem[];
}

export interface OverrideRow {
  publicId: string;
  reasonCode: OverrideReason;
  pool: 'general' | 'accommodation';
  createdBeforeFreeze: boolean;
  createdAt: string;
  actor: string;
  inSnapshot: boolean | null;
}

export interface StaffLogEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  reasonCode: string | null;
  detail: Record<string, unknown>;
  auditSeq: number | null;
}

export interface DrawStatus {
  serverTime: string;
  status: string;
  timing: 'standard' | 'demo';
  windowClose: string;
  drandRound: number | null;
  roundAt: string | null;
  freezeDeadline: string | null;
  inputsHash: string | null;
  snapshot: { frozenAt: string; applications: number; children: number; seats: number; overrides: number } | null;
  run: {
    id: string;
    status: string;
    cursor: number;
    seed: string | null;
    beaconVerified: boolean;
    beaconAttempts: number;
    beaconLastError: string | null;
    planHash: string | null;
    error: string | null;
    finishedAt: string | null;
  } | null;
  offersIssuedAt: string | null;
}

export type PrivilegedResult = { status: 'changed' | 'replayed'; auditSeq: number | null };

/** Typed wrappers over ConsoleApi.command. */
export const consoleCalls = (api: ConsoleApi) => ({
  demand: () => api.command<DemandReport>({ action: 'demand' }),
  verificationQueue: () => api.command<VerificationQueue>({ action: 'verificationQueue' }),
  verifyTier: (publicId: string, tier: number, reasonCode: VerificationReason, idempotencyKey: string) =>
    api.command<PrivilegedResult & { inSnapshot: boolean }>({ action: 'verifyTier', publicId, tier, reasonCode, idempotencyKey }),
  overrides: () => api.command<{ locked: boolean; overrides: OverrideRow[] }>({ action: 'overrides' }),
  createOverride: (publicId: string, reasonCode: OverrideReason, pool: 'general' | 'accommodation', idempotencyKey: string) =>
    api.command<PrivilegedResult & { inSnapshot: boolean }>({ action: 'createOverride', publicId, reasonCode, pool, idempotencyKey }),
  removeOverride: (publicId: string, idempotencyKey: string) => api.command<PrivilegedResult>({ action: 'removeOverride', publicId, idempotencyKey }),
  staffLog: () => api.command<{ entries: StaffLogEntry[] }>({ action: 'staffLog' }),
  fairness: () => api.command<{ ready: false } | { ready: true; inputsHash: string; report: FairnessReport }>({ action: 'fairness' }),
  drawStatus: () => api.command<DrawStatus>({ action: 'drawStatus' }),
  setCapacity: (ledgerId: string, capacity: number) => api.command<{ status: string; capacity: number }>({ action: 'setCapacity', ledgerId, capacity }),
  offersOverview: () => api.command<OrganiserOffersOverview>({ action: 'offersOverview' }),
  cancelOffers: (placementIds: string[], idempotencyKey: string) =>
    api.command<{ status: 'changed' | 'replayed' | 'unchanged'; cancelled: string[]; promoted: number }>({ action: 'cancelOffers', placementIds, idempotencyKey }),
  processOffers: () => api.command<SweepResult>({ action: 'processOffers' }),
});

// ---- judge sandbox controls --------------------------------------------------------------

export interface InspectorStep {
  op: string;
  detail: string;
  outcome: 'ok' | 'refused' | 'info';
}

export interface SandboxFamily {
  key: string;
  label: string;
  publicId: string | null;
  children: { name: string; ranked: string[]; requested: number }[];
  siblingMode: 'together_only' | 'together_preferred' | 'independent';
  tier: number | null;
  tierLabel: string | null;
  nearBoundary: boolean;
  submittedAt: string | null;
  note: string | null;
  offers: { placementId: string; week: string; ageGroup: string; status: OfferStatus; expiresAt: string | null; source: 'draw' | 'waitlist' }[];
  waiting: number;
}

export interface SandboxStatus {
  scenario: string;
  generation: number;
  program: { id: string; name: string; status: string; timezone: string; windowOpen: string; windowClose: string; demoAdvancedMs: number; offersIssuedAt: string | null };
  timing: { roundDelayMs: number; freezeMarginMs: number };
  draw: DrawStatus;
  sessions: { ledgerId: string; week: string; label: string; ageGroup: string; capacity: number; taken: number }[];
  families: SandboxFamily[];
  ownApplications: number;
  cleanupPending: number;
  duplicateHint: { firstName: string; lastName: string; birthdate: string };
  rollbackFamily: { label: string; children: { name: string; ageGroup: string }[] };
}

type Steps = { steps: InspectorStep[] };
const demo = <T,>(app: BrowserAppwrite, request: DemoRequest) => callFunction<T>(app, 'demo', { ...request });

export const demoApi = (app: BrowserAppwrite) => ({
  status: () => demo<SandboxStatus>(app, { action: 'status' }),
  reset: (idempotencyKey: string) => demo<{ status: string; generation: number; programId: string }>(app, { action: 'reset', idempotencyKey }),
  closeApplications: () => demo<Steps & { status: string; advancedMs?: number }>(app, { action: 'closeApplications' }),
  runDraw: () => demo<Steps & { status: DrawStatus }>(app, { action: 'runDraw' }),
  expireOffers: () => demo<Steps & { sweep: SweepResult }>(app, { action: 'expireOffers' }),
  respondAs: (publicId: string, response: OfferResponse) => demo<Steps & { result: { status: string; promoted: number } }>(app, { action: 'respondAs', publicId, response }),
  duplicateChild: () => demo<Steps & { outcome: string; ticketsForChild: number; linkRequests: number }>(app, { action: 'duplicateChild' }),
  rollback: () => demo<Steps & { week: string; refused: boolean }>(app, { action: 'rollback' }),
});
