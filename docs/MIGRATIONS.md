# Schema migrations

The provisioner (`npm run db:provision`) only adds missing tables, columns and
indexes; it never deletes or alters existing ones. Incompatible changes are
done by numbered, explicit migration scripts that refuse to touch tables
holding data.

## 001: households (2026-10-25)

`npm run db:migrate:001` (dry run), then `npm run db:migrate:001 -- --apply`, then `npm run db:provision`.

Why: the design brief's `families` table mixed the household (guardians,
children, home) with per-program lottery data (tier, sibling mode, status).
A family that enters two programs needs one household and two applications.

| Before | After |
|---|---|
| `families` (per program) | `families` = household (program-independent) + new `applications` (per program) |
| `children` (per program, with `child_key`) | `children` = household child; new `tickets` holds `child_key`, UNIQUE(program_id, child_key) |
| `guardians` (with `program_id`) | `guardians` without `program_id`; UNIQUE(user_id): one household per account |
| `family_locations` (with `program_id`) | without `program_id` |
| `placements` UNIQUE(child_id, week) | UNIQUE(program_id, child_id, week): a child may attend two different programs in the same week |
| `preferences` UNIQUE(child_id) | UNIQUE(program_id, child_id) |
| — | new `guardian_invites`, `link_requests` |

Safety: the script lists row counts and aborts if any table to be recreated
is non-empty. Index changes delete no data.

## 002: offer "cancelled" state (2026-10-25)

`npm run db:migrate:002` (dry run), then `npm run db:migrate:002 -- --apply`, then `npm run db:provision`.

Why: Task 11's offer lifecycle (see [OFFERS.md](OFFERS.md)) needs a state for
offers an organiser withdraws. The provisioner never alters an existing
column, so adding the enum element is explicit.

| Before | After |
|---|---|
| `placements.status` ∈ offered, accepted, declined, expired, released | + `cancelled` |

Safety: adding an element keeps every stored value valid; the script aborts
if the schema would remove an element. The other Task 11 additions are new
optional columns (`placements.offered_at/responded_at/source`,
`preferences.held_weeks`, `waitlist.rank`, `programs.offers_issued_at/offers_swept_at`),
new indexes and the new public `offer_stats` table, all created by
`npm run db:provision`.

## 003: tickets readable by the household only (2026-10-25)

`npm run db:migrate:003` (dry run), then `npm run db:migrate:003 -- --apply`.

Why: Task 14 security review. Tickets carry `child_key`, and organisers who
could read every key could confirm guessed identities (by registering a guess
in their own household and comparing keys). New tickets are created without
the organiser-team grant; this removes it from earlier tickets in production
programs. Demo sandbox tickets keep their sandbox-team grant.

| Before | After |
|---|---|
| `tickets` rows: `read(user:<guardian>)` + `read(team:<organisers>)` | `read(user:<guardian>)` only |

Applied on 2026-10-25: 208 tickets changed (all in synthetic programs); a rerun reports 0.
Task 14 also added `rate_limits` (table) and `sandboxes.ip_hash` (column), both
created by `npm run db:provision` with no migration needed.
