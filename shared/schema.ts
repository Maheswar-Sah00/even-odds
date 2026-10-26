import type { TableKey } from './config.ts';

/**
 * Declarative TablesDB schema: the single source of truth for provisioning
 * (functions/shared/provisioning.ts), row types (RowData below) and docs
 * (docs/SCHEMA.md). Field meanings follow docs/EvenOdds-design-brief.pdf §6;
 * every addition beyond the brief is marked "ADDITION" with its reason.
 *
 * Conventions
 * - Foreign keys are plain varchar(36) ID columns, not relationship columns:
 *   they can join composite unique indexes and be written inside
 *   transactions without relying on relationship semantics.
 * - Required columns have no defaults (Appwrite rejects defaults on required
 *   columns), so every writer sets them explicitly.
 */

export type ColumnSpec = { description: string; required: boolean } & (
  | { type: 'varchar'; size: number; array?: boolean }
  | { type: 'text' }
  /** Up to 4 GB of UTF-8 text, stored off-row (TablesDB longtext). */
  | { type: 'longtext' }
  | { type: 'integer'; min?: number; max?: number }
  | { type: 'boolean' }
  | { type: 'datetime' }
  | { type: 'enum'; elements: readonly string[] }
  | { type: 'point' }
  | { type: 'polygon' }
);

export interface IndexSpec {
  key: string;
  type: 'key' | 'unique' | 'spatial';
  columns: readonly string[];
}

export interface TableSpec {
  name: string;
  description: string;
  /** Row security on: per-row permissions, granted by server code at write time. */
  rowSecurity: boolean;
  /** Table-level permissions. Clients never get create/update/delete; writes go through server code. */
  permissions: readonly string[];
  columns: Readonly<Record<string, ColumnSpec>>;
  indexes: readonly IndexSpec[];
}

const PUBLIC_READ = ['read("any")'] as const;
const NONE = [] as const;

const id = (description: string) => ({ type: 'varchar', size: 36, required: true, description }) as const;
const hash = (description: string) => ({ type: 'varchar', size: 64, required: true, description }) as const;
const optionalHash = (description: string) => ({ type: 'varchar', size: 64, required: false, description }) as const;
const WEEK = { type: 'varchar', size: 16, required: true, description: 'Program-defined week code, e.g. "2027-W26".' } as const;
const AGE_GROUP = { type: 'varchar', size: 16, required: true, description: 'Age group code, e.g. "6-8".' } as const;

export const SIBLING_MODES = ['together_only', 'together_preferred', 'independent'] as const;
/** Offer lifecycle (functions/shared/offers.ts). "offered" is the pending state; "cancelled" was added in migration 002. */
export const PLACEMENT_STATUSES = ['offered', 'accepted', 'declined', 'expired', 'released', 'cancelled'] as const;
export const PROGRAM_NAMESPACES = ['production', 'demo'] as const;
export const OVERRIDE_REASONS = ['accommodation', 'sibling_enrolled', 'staff_family', 'policy_exception'] as const;

export const SCHEMA = {
  programs: {
    name: 'Programs',
    description: 'A lottery-run program (e.g. a summer camp season). Drafts: organisers only. Published: anyone (row grant read("any")). Demo sandboxes (namespace "demo"): their visitor only, through a per-sandbox Team.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      org_team_id: id('Appwrite Team ID whose members organise this program.'),
      name: { type: 'varchar', size: 128, required: true, description: 'Display name.' },
      timezone: { type: 'varchar', size: 64, required: true, description: 'ADDITION: IANA timezone for window times and age-at-week-start.' },
      window_open: { type: 'datetime', required: true, description: 'Application window opens.' },
      window_close: { type: 'datetime', required: true, description: 'Application window closes (freeze).' },
      max_weeks: { type: 'integer', min: 1, max: 12, required: true, description: 'K: max weeks per child (snake-draft rounds).' },
      drand_round: { type: 'integer', min: 0, required: false, description: 'Future drand round announced at window open (set once, at publish).' },
      drand_chain: { type: 'varchar', size: 64, required: false, description: 'ADDITION (Task 10): hash of the drand chain the announced round belongs to (pinned, see shared/freeze/drand.ts).' },
      inputs_hash: optionalHash('SHA-256 of frozen draw inputs, published at freeze.'),
      status: { type: 'enum', elements: ['draft', 'open', 'frozen', 'drawn', 'closed'], required: true, description: 'Lifecycle state.' },
      synthetic: { type: 'boolean', required: true, description: 'ADDITION: true for demo data; UI labels it as synthetic.' },
      description: { type: 'text', required: false, description: 'ADDITION: public description shown in the catalogue.' },
      default_tier: { type: 'integer', min: 0, max: 9, required: false, description: 'ADDITION: tier for homes outside every priority zone.' },
      tier_labels: { type: 'text', required: false, description: 'ADDITION: JSON object of tier number to public label, e.g. {"0":"Priority zone","1":"Everyone else"}.' },
      published_at: { type: 'datetime', required: false, description: 'ADDITION: when the organiser published the catalogue (server time).' },
      source_note: { type: 'varchar', size: 256, required: false, description: 'ADDITION: data provenance shown to users, e.g. "Synthetic demo catalogue".' },
      late_policy: { type: 'enum', elements: ['none', 'accept_late'], required: false, description: 'ADDITION: whether submissions after window_close are accepted until freeze (late applicants rank after on-time ones). Null = none.' },
      offers_issued_at: { type: 'datetime', required: false, description: 'ADDITION (Task 11): Appwrite server time the draw offers were issued (their 48 h clock starts here). Families can respond only once set.' },
      offers_swept_at: { type: 'datetime', required: false, description: 'ADDITION (Task 11): server time of the last completed expiry/promotion sweep.' },
      namespace: {
        type: 'enum',
        elements: PROGRAM_NAMESPACES,
        required: false,
        description: 'ADDITION (Task 12): "demo" marks a judge-sandbox program (synthetic, demo timing, private to its visitor). Null = production. Enforced server-side in both directions (functions/shared/namespace.ts).',
      },
      sandbox_owner: { type: 'varchar', size: 36, required: false, description: 'ADDITION (Task 12): Appwrite user ID of the visitor who owns this demo sandbox. Null for production programs.' },
      demo_advanced_ms: { type: 'integer', min: 0, required: false, description: 'ADDITION (Task 12): total demo time this sandbox has been fast-forwarded (its own deadlines moved earlier; the server clock is never changed).' },
    },
    indexes: [
      { key: 'idx_status', type: 'key', columns: ['status'] },
      { key: 'idx_namespace', type: 'key', columns: ['namespace'] },
      { key: 'idx_sandbox_owner', type: 'key', columns: ['sandbox_owner'] },
    ],
  },

  seat_ledger: {
    name: 'Seat ledger',
    description: 'Capped seat counter per (program, week, age group). Readable by anyone once the program is published.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      week: WEEK,
      week_start: { type: 'datetime', required: true, description: 'ADDITION: first day of the week; age is computed as of this date.' },
      age_group: AGE_GROUP,
      min_age: { type: 'integer', min: 0, max: 25, required: true, description: 'ADDITION: youngest eligible age (years, at week_start).' },
      max_age: { type: 'integer', min: 0, max: 25, required: true, description: 'ADDITION: oldest eligible age (years, at week_start).' },
      capacity: { type: 'integer', min: 0, max: 100000, required: true, description: 'Seats available.' },
      taken: { type: 'integer', min: 0, max: 100000, required: true, description: 'Seats taken; only changed via incrementRowColumn(max = capacity).' },
      label: { type: 'varchar', size: 64, required: false, description: 'ADDITION: human-friendly session name, e.g. "Week 1: Jun 14-18".' },
    },
    indexes: [{ key: 'uq_program_week_age', type: 'unique', columns: ['program_id', 'week', 'age_group'] }],
  },

  zones: {
    name: 'Zones',
    description: 'Priority-zone polygons per program, [longitude, latitude] rings. Readable by anyone once published.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      name: { type: 'varchar', size: 64, required: true, description: 'Zone label.' },
      tier: { type: 'integer', min: 0, max: 9, required: true, description: 'Priority tier (lower draws first).' },
      area: { type: 'polygon', required: true, description: 'Zone boundary.' },
    },
    indexes: [
      { key: 'idx_program', type: 'key', columns: ['program_id'] },
      { key: 'sp_area', type: 'spatial', columns: ['area'] },
    ],
  },

  families: {
    name: 'Families',
    description:
      'A household: guardians and children, independent of any program. (Migration 001 moved per-program fields to applications.) Row security: its guardians.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      created_by: id('Appwrite user ID of the guardian who created the household.'),
      synthetic: { type: 'boolean', required: true, description: 'ADDITION: true for generated demo households.' },
    },
    indexes: [{ key: 'idx_created_by', type: 'key', columns: ['created_by'] }],
  },

  family_locations: {
    name: 'Family locations',
    description:
      'ADDITION: private home point, split from families because permissions are per row, not per column. Readable by the household only; organisers see tiers, not homes.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      family_id: id('families.$id'),
      home: { type: 'point', required: true, description: 'Home location as [longitude, latitude] (private).' },
    },
    indexes: [{ key: 'uq_family', type: 'unique', columns: ['family_id'] }],
  },

  guardians: {
    name: 'Guardians',
    description: 'Links Appwrite users to households. A user belongs to at most one household.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      user_id: id('Appwrite user ID.'),
      family_id: id('families.$id'),
      role: { type: 'enum', elements: ['primary', 'linked'], required: true, description: 'ADDITION: household creator, or a guardian who joined by invite.' },
    },
    indexes: [
      { key: 'uq_user', type: 'unique', columns: ['user_id'] },
      { key: 'idx_family', type: 'key', columns: ['family_id'] },
    ],
  },

  children: {
    name: 'Children',
    description: 'A child in a household (private). Program tickets live in `tickets`.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      family_id: id('families.$id'),
      first_name: { type: 'varchar', size: 64, required: true, description: 'Given name (private; never published).' },
      last_name: { type: 'varchar', size: 64, required: true, description: 'ADDITION: family name, part of child_key to reduce false duplicate matches.' },
      birthdate: { type: 'datetime', required: true, description: 'Date of birth (private; never published).' },
    },
    indexes: [{ key: 'idx_family', type: 'key', columns: ['family_id'] }],
  },

  tickets: {
    name: 'Tickets',
    description:
      'ADDITION (brief: "the child is the ticket"): one lottery entry per child per program. UNIQUE(program_id, child_key) blocks a second ticket from another account or household.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      child_id: id('children.$id'),
      family_id: id('families.$id'),
      child_key: hash('HMAC-SHA256(server secret, normalised name + birthdate + program). Not reversible without the secret.'),
    },
    indexes: [
      { key: 'uq_program_child_key', type: 'unique', columns: ['program_id', 'child_key'] },
      { key: 'uq_program_child', type: 'unique', columns: ['program_id', 'child_id'] },
      { key: 'idx_family', type: 'key', columns: ['family_id'] },
    ],
  },

  applications: {
    name: 'Applications',
    description: "ADDITION: a household's lottery entry for one program (the per-program part of the brief's families table).",
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      family_id: id('families.$id'),
      public_id: { type: 'varchar', size: 32, required: true, description: 'Pseudonymous public identifier used in draw inputs and audit.' },
      claimed_tier: { type: 'integer', min: 0, max: 9, required: false, description: 'Tier from the zone containing the claimed home.' },
      verified_tier: { type: 'integer', min: 0, max: 9, required: false, description: 'Tier after organiser residency verification.' },
      near_boundary: { type: 'boolean', required: false, description: 'ADDITION: home within 50 m of a zone edge; flags verification.' },
      sibling_mode: { type: 'enum', elements: SIBLING_MODES, required: true, description: 'How siblings are placed.' },
      status: { type: 'enum', elements: ['draft', 'submitted', 'withdrawn'], required: true, description: 'ADDITION: application lifecycle.' },
      submitted_at: { type: 'datetime', required: false, description: 'ADDITION: server time of first submission. Never used for ordering within a tier.' },
      late: { type: 'boolean', required: false, description: 'ADDITION: submitted after window_close under an accept_late policy; ranks after on-time applicants.' },
      synthetic: { type: 'boolean', required: true, description: 'ADDITION: true for generated demo applications.' },
    },
    indexes: [
      { key: 'uq_program_family', type: 'unique', columns: ['program_id', 'family_id'] },
      { key: 'uq_program_public_id', type: 'unique', columns: ['program_id', 'public_id'] },
      { key: 'idx_program_status', type: 'key', columns: ['program_id', 'status'] },
    ],
  },

  guardian_invites: {
    name: 'Guardian invites',
    description: 'ADDITION: single-use codes that let a second guardian join a household. Only the code hash is stored. Server only.',
    rowSecurity: false,
    permissions: NONE,
    columns: {
      family_id: id('families.$id'),
      code_hash: hash('SHA-256 of the invite code; the code itself is shown once to the inviter.'),
      created_by: id('Inviting guardian.'),
      expires_at: { type: 'datetime', required: true, description: 'Invite expiry (72 h).' },
      status: { type: 'enum', elements: ['pending', 'accepted', 'revoked'], required: true, description: 'Invite lifecycle.' },
      accepted_by: { type: 'varchar', size: 36, required: false, description: 'User who accepted.' },
    },
    indexes: [
      { key: 'uq_code_hash', type: 'unique', columns: ['code_hash'] },
      { key: 'idx_family', type: 'key', columns: ['family_id'] },
    ],
  },

  link_requests: {
    name: 'Link requests',
    description:
      'ADDITION: raised when a guardian tries to register a child who already has a ticket in another household. Readable by the EXISTING household only; carries no details about the requester.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      family_id: id('Existing household that holds the ticket.'),
      ticket_id: id('tickets.$id of the existing ticket.'),
      requester_hash: hash('SHA-256 of the requesting household ID: deduplicates requests without exposing who asked.'),
      status: { type: 'enum', elements: ['open', 'dismissed'], required: true, description: 'Whether the existing household has acted on it.' },
    },
    indexes: [
      { key: 'uq_ticket_requester', type: 'unique', columns: ['ticket_id', 'requester_hash'] },
      { key: 'idx_family', type: 'key', columns: ['family_id'] },
    ],
  },

  preferences: {
    name: 'Preferences',
    description: 'Ranked weeks per child per program.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      child_id: id('children.$id'),
      family_id: id('families.$id'),
      program_id: id('ADDITION: programs.$id.'),
      ranked_weeks: { type: 'varchar', size: 16, array: true, required: true, description: 'Week codes, most preferred first.' },
      ranked_age_groups: { type: 'varchar', size: 16, array: true, required: false, description: 'ADDITION: age group for each ranked week, computed server-side from the birthdate at submission so draw inputs need no birthdates.' },
      requested_weeks: { type: 'integer', min: 1, max: 12, required: true, description: 'How many weeks the family wants for this child (<= max_weeks).' },
      held_weeks: { type: 'integer', min: 0, max: 12, required: false, description: 'ADDITION (Task 11): weeks this child holds (offered or accepted). Set when offers are issued, then changed only by capped increment (max = requested_weeks) / decrement (min = 0) in the same transaction as the placement change.' },
    },
    indexes: [{ key: 'uq_program_child', type: 'unique', columns: ['program_id', 'child_id'] }],
  },

  placements: {
    name: 'Placements',
    description: 'A seat held by a child for a week. UNIQUE(program_id, child_id, week) prevents double placement.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('ADDITION: programs.$id.'),
      child_id: id('children.$id'),
      family_id: id('ADDITION: families.$id, so guardians can list a family\'s placements.'),
      ledger_id: id('ADDITION: seat_ledger.$id whose taken counter this placement holds.'),
      week: WEEK,
      age_group: AGE_GROUP,
      status: { type: 'enum', elements: PLACEMENT_STATUSES, required: true, description: 'Offer lifecycle.' },
      expires_at: { type: 'datetime', required: false, description: 'Offer expiry (48 h).' },
      draw_run_id: { type: 'varchar', size: 36, required: false, description: 'ADDITION: draw_runs.$id that created it.' },
      round: { type: 'integer', min: 1, max: 12, required: false, description: 'ADDITION: snake-draft round.' },
      offered_at: { type: 'datetime', required: false, description: 'ADDITION (Task 11): Appwrite server time the offer was issued; expires_at = offered_at + 48 h.' },
      responded_at: { type: 'datetime', required: false, description: 'ADDITION (Task 11): server time (Operator.dateSetNow) of the transition out of the current state.' },
      source: { type: 'enum', elements: ['draw', 'waitlist'], required: false, description: 'ADDITION (Task 11): how the offer was made. Null = draw.' },
    },
    indexes: [
      { key: 'uq_program_child_week', type: 'unique', columns: ['program_id', 'child_id', 'week'] },
      { key: 'idx_program_week_status', type: 'key', columns: ['program_id', 'week', 'status'] },
      { key: 'idx_family', type: 'key', columns: ['family_id'] },
      { key: 'idx_status_expires', type: 'key', columns: ['status', 'expires_at'] },
    ],
  },

  waitlist: {
    name: 'Waitlist',
    description: 'Strict lottery-order waitlist per (program, week, age group).',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      week: WEEK,
      age_group: AGE_GROUP,
      family_id: id('families.$id'),
      child_id: id('ADDITION: children.$id; waitlisting is per child.'),
      position: { type: 'integer', min: 1, max: 1000000, required: true, description: 'Lottery-order position.' },
      status: { type: 'enum', elements: ['waiting', 'promoted', 'removed'], required: true, description: 'ADDITION: entry lifecycle.' },
      rank: { type: 'integer', min: 0, max: 1000000, required: false, description: "ADDITION (Task 11): the family's position in the draw's lottery order (plan.order), so promotion can merge a week's age-group lists in strict lottery order." },
    },
    indexes: [
      { key: 'uq_slot_child', type: 'unique', columns: ['program_id', 'week', 'age_group', 'child_id'] },
      { key: 'uq_slot_position', type: 'unique', columns: ['program_id', 'week', 'age_group', 'position'] },
      { key: 'idx_program_status', type: 'key', columns: ['program_id', 'status'] },
    ],
  },

  overrides: {
    name: 'Overrides',
    description: 'Pre-freeze organiser overrides with reason codes; hashed into inputs and counted publicly.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('ADDITION: programs.$id.'),
      family_id: id('families.$id'),
      reason_code: {
        type: 'enum',
        elements: OVERRIDE_REASONS,
        required: true,
        description: 'Why the override exists. No free text, so no PII.',
      },
      pool: { type: 'enum', elements: ['general', 'accommodation'], required: true, description: 'Seat pool the override draws from.' },
      created_before_freeze: { type: 'boolean', required: true, description: 'Set by server time, never by the client. Re-checked after commit against the published snapshot (functions/shared/console.ts).' },
      created_by: id('ADDITION: organiser user ID (the authorised actor). The timestamp is the row\'s server-set $createdAt.'),
    },
    indexes: [{ key: 'uq_program_family', type: 'unique', columns: ['program_id', 'family_id'] }],
  },

  staff_actions: {
    name: 'Staff actions',
    description:
      'ADDITION (Task 12): log of every privileged organiser change (overrides, tier verification, capacity, freeze, demo time travel), written in the same transaction as the change. Names the actor, so it is readable by the program\'s organiser team only; a pseudonymous copy goes to the public audit_log.',
    rowSecurity: true,
    permissions: NONE,
    columns: {
      program_id: id('programs.$id'),
      actor_id: id('Appwrite user ID of the organiser (or demo visitor) who made the change.'),
      action: { type: 'varchar', size: 48, required: true, description: 'What was done, e.g. "override_created".' },
      target: { type: 'varchar', size: 64, required: false, description: 'Pseudonymous target: an application public ID, a session code or a ticket ref. Never a name.' },
      reason_code: { type: 'varchar', size: 32, required: false, description: 'Reason code from a fixed list (no free text).' },
      detail: { type: 'text', required: false, description: 'Canonical JSON with before/after values (pseudonymous only).' },
      audit_seq: { type: 'integer', min: 1, required: false, description: 'seq of the public audit_log entry written with it.' },
    },
    indexes: [{ key: 'idx_program', type: 'key', columns: ['program_id'] }],
  },

  draw_runs: {
    name: 'Draw runs',
    description: 'Resumable draw executions. Public.',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      status: { type: 'enum', elements: ['pending', 'running', 'completed', 'failed'], required: true, description: 'Run state.' },
      drand_round: { type: 'integer', min: 0, required: true, description: 'drand round that seeds this run.' },
      seed: { type: 'varchar', size: 128, required: false, description: 'ADDITION: drand randomness (hex) once fetched.' },
      inputs_hash: hash('Inputs hash the run was computed from.'),
      plan_hash: optionalHash('ADDITION: SHA-256 of the computed placement plan, for replay comparison.'),
      cursor: { type: 'integer', min: 0, required: true, description: 'Next plan step to commit (resume point).' },
      started_at: { type: 'datetime', required: false, description: 'ADDITION.' },
      finished_at: { type: 'datetime', required: false, description: 'ADDITION.' },
      error: { type: 'varchar', size: 256, required: false, description: 'ADDITION: failure summary (no PII).' },
      seed_scheme: { type: 'varchar', size: 32, required: false, description: 'ADDITION (Task 10): how seed was derived from the beacon, e.g. even-odds-seed-v1.' },
      drand_chain: { type: 'varchar', size: 64, required: false, description: 'ADDITION (Task 10): drand chain hash of the beacon.' },
      beacon_randomness: { type: 'varchar', size: 64, required: false, description: 'ADDITION (Task 10): verified drand randomness (hex) for drand_round.' },
      beacon_signature: { type: 'varchar', size: 192, required: false, description: 'ADDITION (Task 10): drand BLS signature (hex) for drand_round, as fetched.' },
      beacon_verified: { type: 'boolean', required: false, description: 'ADDITION (Task 10): true once the beacon signature verified against the pinned chain key.' },
      beacon_verified_at: { type: 'datetime', required: false, description: 'ADDITION (Task 10): server time of verification.' },
      beacon_verifier: { type: 'varchar', size: 64, required: false, description: 'ADDITION (Task 10): verifier used, e.g. drand-client 1.4.2 (bls-unchained-g1-rfc9380).' },
      beacon_attempts: { type: 'integer', min: 0, max: 100000, required: false, description: 'ADDITION (Task 10): fetch/verify attempts so far.' },
      beacon_last_error: { type: 'varchar', size: 256, required: false, description: 'ADDITION (Task 10): why the last attempt did not produce a verified beacon (draw stays pending).' },
    },
    indexes: [{ key: 'idx_program', type: 'key', columns: ['program_id'] }],
  },

  frozen_inputs: {
    name: 'Frozen inputs',
    description:
      'ADDITION (Task 10): the canonical draw inputs frozen when applications close, one row per program, written once inside the freeze transaction. Public, pseudonymous only (no names, birthdates, homes, family or user IDs).',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      format: { type: 'varchar', size: 48, required: true, description: 'Canonical serialization format, e.g. even-odds-frozen-inputs-v1.' },
      algorithm: { type: 'varchar', size: 48, required: true, description: 'Draw algorithm the inputs were frozen for, e.g. even-odds-draw-v1.' },
      inputs_hash: hash('SHA-256 (hex) of the UTF-8 bytes of `canonical`; equals programs.inputs_hash.'),
      canonical: { type: 'longtext', required: true, description: 'The exact canonical serialization that was hashed (docs/FREEZE-PROTOCOL.md).' },
      frozen_at: { type: 'datetime', required: true, description: 'Server time the freeze transaction was built.' },
      applications: { type: 'integer', min: 0, required: true, description: 'Public record count: applications in the inputs.' },
      children: { type: 'integer', min: 0, required: true, description: 'Public record count: children (tickets) in the inputs.' },
      sessions: { type: 'integer', min: 0, required: true, description: 'Public record count: sessions (capacity snapshot).' },
      seats: { type: 'integer', min: 0, required: true, description: 'Total capacity across sessions.' },
      overrides: { type: 'integer', min: 0, required: true, description: 'Approved pre-freeze overrides in the inputs.' },
      override_counts: { type: 'varchar', size: 512, required: true, description: 'JSON object reason_code -> count (categories only, no families).' },
      drand_chain: { type: 'varchar', size: 64, required: true, description: 'drand chain hash of the pre-announced round.' },
      drand_round: { type: 'integer', min: 1, required: true, description: 'The pre-announced drand round that will seed the draw.' },
      drand_round_at: { type: 'datetime', required: true, description: 'When that round is due (genesis + (round - 1) x period).' },
      application_order: {
        type: 'longtext',
        required: false,
        description: 'ADDITION (Task 13): canonical JSON array of the frozen applications (public IDs) in submission order (no timestamps), committed in the freeze transaction. Not a draw input; used by the fairness report. Null for programs frozen before Task 13.',
      },
      application_order_hash: optionalHash('ADDITION (Task 13): SHA-256 of `application_order`; also in the inputs_frozen audit payload.'),
    },
    indexes: [{ key: 'uq_program', type: 'unique', columns: ['program_id'] }],
  },
  draw_results: {
    name: 'Draw results',
    description:
      'ADDITION (Task 13): the published draw result, one row per program, written once after the draw commits: the placements and initial waitlist read back from the committed rows, as pseudonymous canonical JSON (even-odds-result-v1, docs/REPLAY.md). Public; the browser replay compares it with its own recomputation.',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      format: { type: 'varchar', size: 48, required: true, description: 'Canonical format, e.g. even-odds-result-v1.' },
      canonical: { type: 'longtext', required: true, description: 'The exact canonical text that was hashed.' },
      result_hash: hash('SHA-256 (hex) of the UTF-8 bytes of `canonical`; also in the result_published audit entry.'),
      draw_run_id: id('draw_runs.$id whose placements this is.'),
      inputs_hash: hash('Inputs hash of the draw run.'),
      plan_hash: hash('Plan hash the draw run recorded.'),
      placements: { type: 'integer', min: 0, required: true, description: 'Public record count: placements in the result.' },
      waitlist: { type: 'integer', min: 0, required: true, description: 'Public record count: waitlist entries in the result.' },
      published_at: { type: 'datetime', required: true, description: 'Server time the result was published.' },
      outcomes: { type: 'longtext', required: false, description: 'Live JSON (not hashed): current offer status per placement and waitlist entry, refreshed by the offers job. Pseudonymous.' },
      outcomes_at: { type: 'datetime', required: false, description: 'Server time of the last outcomes refresh.' },
    },
    indexes: [{ key: 'uq_program', type: 'unique', columns: ['program_id'] }],
  },
  offer_stats: {
    name: 'Offer stats',
    description:
      'ADDITION (Task 11): public, pseudonymous aggregate offer and waitlist counts per session, recomputed by the offers job from placements and waitlist. Display only; never used for seat decisions (seat_ledger is authoritative).',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      week: WEEK,
      age_group: AGE_GROUP,
      capacity: { type: 'integer', min: 0, max: 100000, required: true, description: 'Copied from seat_ledger.capacity.' },
      taken: { type: 'integer', min: 0, max: 100000, required: true, description: 'Copied from seat_ledger.taken (seats held by pending or accepted offers).' },
      pending: { type: 'integer', min: 0, max: 100000, required: true, description: 'Offers awaiting a reply.' },
      accepted: { type: 'integer', min: 0, max: 100000, required: true, description: 'Accepted offers.' },
      waiting: { type: 'integer', min: 0, max: 1000000, required: true, description: 'Children still on the waitlist.' },
      promoted: { type: 'integer', min: 0, max: 1000000, required: true, description: 'Waitlist entries that received an offer.' },
      computed_at: { type: 'datetime', required: true, description: 'Server time of the recount.' },
    },
    indexes: [{ key: 'uq_session', type: 'unique', columns: ['program_id', 'week', 'age_group'] }],
  },

  audit_log: {
    name: 'Audit log',
    description: 'Public, append-only, hash-chained event log. Pseudonymous identifiers only.',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      seq: { type: 'integer', min: 1, required: true, description: 'ADDITION: position in the chain; UNIQUE per program prevents forks.' },
      event: { type: 'varchar', size: 64, required: true, description: 'Event name, e.g. "inputs_frozen".' },
      payload: { type: 'text', required: true, description: 'ADDITION: canonical JSON payload (pseudonymous IDs only).' },
      payload_hash: hash('SHA-256 of payload.'),
      prev_hash: hash('Hash of the previous entry ("0"*64 for the first).'),
      entry_hash: hash('ADDITION: SHA-256(prev_hash || seq || event || payload_hash); the next entry\'s prev_hash.'),
    },
    indexes: [
      { key: 'uq_program_seq', type: 'unique', columns: ['program_id', 'seq'] },
      { key: 'idx_program_event', type: 'key', columns: ['program_id', 'event'] },
    ],
  },

  odds_snapshots: {
    name: 'Odds snapshots',
    description:
      'ADDITION: the latest published odds estimate per program (aggregates only: per-tier bands and per-session demand). Public; one row per program, updated at most hourly, frozen 24 h before close.',
    rowSecurity: false,
    permissions: PUBLIC_READ,
    columns: {
      program_id: id('programs.$id'),
      computed_at: { type: 'datetime', required: true, description: 'When this estimate was computed (server time).' },
      model_version: { type: 'varchar', size: 32, required: true, description: 'Estimator version, e.g. odds-v1.' },
      iterations: { type: 'integer', min: 0, max: 1000000, required: true, description: 'Monte Carlo iterations.' },
      seed: { type: 'varchar', size: 64, required: true, description: 'PRNG seed string, so the estimate can be reproduced.' },
      applicants: { type: 'integer', min: 0, required: true, description: 'Submitted applications counted.' },
      children: { type: 'integer', min: 0, required: true, description: 'Children across those applications.' },
      seats: { type: 'integer', min: 0, required: true, description: 'Total capacity across sessions.' },
      tiers: { type: 'text', required: true, description: 'JSON array of per-tier odds (small tiers suppressed).' },
      sessions: { type: 'text', required: true, description: 'JSON array of per-session demand.' },
      frozen: { type: 'boolean', required: true, description: 'True once the 24-hour pre-close freeze applies; no further updates.' },
      freeze_at: { type: 'datetime', required: true, description: 'window_close minus 24 hours.' },
    },
    indexes: [{ key: 'uq_program', type: 'unique', columns: ['program_id'] }],
  },

  idempotency: {
    name: 'Idempotency',
    description: 'ADDITION (brief: "idempotency per (family, round)"): one row per completed request, written in the same transaction as its effect.',
    rowSecurity: false,
    permissions: NONE,
    columns: {
      scope: { type: 'varchar', size: 32, required: true, description: 'Operation family, e.g. "place".' },
      program_id: id('programs.$id'),
      key_hash: hash('SHA-256 of the caller-supplied idempotency key.'),
      result: { type: 'text', required: false, description: 'JSON summary of the committed result, returned on replay.' },
    },
    indexes: [{ key: 'uq_scope_key', type: 'unique', columns: ['scope', 'key_hash'] }],
  },

  sandboxes: {
    name: 'Sandboxes',
    description:
      'ADDITION (Task 12): registry of judge-demo sandboxes, one per visitor. Server only: the browser never names a sandbox; the api derives it from the caller. Resets move to a new generation (a fresh program ID) and delete the old one.',
    rowSecurity: false,
    permissions: NONE,
    columns: {
      owner_id: id('Appwrite user ID of the visitor (usually an anonymous session).'),
      team_id: id('Per-sandbox Appwrite Team (random ID) whose only member is the visitor; grants read on the sandbox rows.'),
      program_id: id('The current generation\'s demo program ID.'),
      generation: { type: 'integer', min: 1, max: 1000000, required: true, description: 'Increments on every reset.' },
      status: { type: 'enum', elements: ['seeding', 'ready'], required: true, description: 'seeding = the current generation is being written (a retry resumes it).' },
      reset_count: { type: 'integer', min: 0, max: 1000000, required: true, description: 'Resets in the current rate-limit window.' },
      reset_window_start: { type: 'datetime', required: true, description: 'Start of the current rate-limit window.' },
      last_active_at: { type: 'datetime', required: true, description: 'Last demo request; idle sandboxes are removed by the jobs Function.' },
      ip_hash: { type: 'varchar', size: 64, required: false, description: 'ADDITION (Task 14): keyed hash (HMAC) of the creating client IP; limits active sandboxes per network. The address itself is not stored.' },
    },
    indexes: [
      { key: 'uq_owner', type: 'unique', columns: ['owner_id'] },
      { key: 'idx_last_active', type: 'key', columns: ['last_active_at'] },
      { key: 'idx_ip_hash', type: 'key', columns: ['ip_hash'] },
    ],
  },

  rate_limits: {
    name: 'Rate limits',
    description:
      'ADDITION (Task 14): fixed-window request counters for sensitive api actions, one row per (bucket, caller, window). The cap is enforced by incrementRowColumn({ max }), the same verified primitive that caps seats. Server only; old windows are deleted by the jobs Function.',
    rowSecurity: false,
    permissions: NONE,
    columns: {
      bucket: { type: 'varchar', size: 32, required: true, description: 'Limited action group, e.g. "identity".' },
      subject_hash: hash('SHA-256 of the caller\'s user ID (no raw IDs stored).'),
      window_start: { type: 'datetime', required: true, description: 'Start of the fixed window this row counts.' },
      count: { type: 'integer', min: 0, max: 1000000, required: true, description: 'Requests counted in the window (capped at the bucket limit).' },
    },
    indexes: [{ key: 'idx_window_start', type: 'key', columns: ['window_start'] }],
  },
} as const satisfies Record<TableKey, TableSpec>;

export type Schema = typeof SCHEMA;

// ---- Row types derived from the schema --------------------------------------

type ScalarOf<C> = C extends { type: 'varchar' | 'text' | 'longtext' | 'datetime' }
  ? string
  : C extends { type: 'integer' }
    ? number
    : C extends { type: 'boolean' }
      ? boolean
      : C extends { type: 'enum'; elements: readonly (infer E)[] }
        ? E
        : C extends { type: 'point' }
          ? [number, number]
          : C extends { type: 'polygon' }
            ? number[][][]
            : never;

type CellOf<C> = (C extends { array: true } ? ScalarOf<C>[] : ScalarOf<C>) | (C extends { required: true } ? never : null);

type Columns<K extends TableKey> = Schema[K]['columns'];
type RequiredKeys<K extends TableKey> = { [P in keyof Columns<K>]: Columns<K>[P] extends { required: true } ? P : never }[keyof Columns<K>];
type OptionalKeys<K extends TableKey> = Exclude<keyof Columns<K>, RequiredKeys<K>>;

/** Column values of a row in table K (without Appwrite's $-prefixed system fields). */
export type RowData<K extends TableKey> = { -readonly [P in RequiredKeys<K>]: CellOf<Columns<K>[P]> } & {
  -readonly [P in OptionalKeys<K>]?: CellOf<Columns<K>[P]>;
};

/** Integer column names of table K (valid targets for increment/decrement). */
export type IntegerColumn<K extends TableKey> = {
  [P in keyof Columns<K>]: Columns<K>[P] extends { type: 'integer' } ? P : never;
}[keyof Columns<K>] &
  string;
