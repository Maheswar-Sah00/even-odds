/**
 * Canonical table keys. The provisioning script creates tables with these IDs;
 * browser config may override an ID per table (see .env.example), but the key
 * used throughout the code base never changes.
 */
export const TABLE_KEYS = [
  'programs',
  'seat_ledger',
  'zones',
  'families',
  'family_locations',
  'guardians',
  'children',
  'tickets',
  'applications',
  'guardian_invites',
  'link_requests',
  'preferences',
  'placements',
  'waitlist',
  'overrides',
  'staff_actions',
  'draw_runs',
  'frozen_inputs',
  'draw_results',
  'offer_stats',
  'audit_log',
  'odds_snapshots',
  'idempotency',
  'sandboxes',
  'rate_limits',
] as const;

export type TableKey = (typeof TABLE_KEYS)[number];
export type TableIds = Readonly<Record<TableKey, string>>;

export const DEFAULT_TABLE_IDS: TableIds = Object.freeze(
  Object.fromEntries(TABLE_KEYS.map((key) => [key, key])) as Record<TableKey, string>,
);

/** Env var name that overrides the ID of a table, e.g. VITE_APPWRITE_TABLE_SEAT_LEDGER. */
export function tableEnvVar(key: TableKey): string {
  return `VITE_APPWRITE_TABLE_${key.toUpperCase()}`;
}

/** Appwrite custom IDs: 1-36 chars of a-z, A-Z, 0-9, '.', '-', '_'; no leading special char. */
export const APPWRITE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;
