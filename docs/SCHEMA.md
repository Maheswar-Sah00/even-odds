# Even Odds schema (TablesDB)

> Generated from `shared/schema.ts` by `npm run docs:schema`. Do not edit by hand.

Fields marked **ADDITION** are not in the design brief's data model; the reason is given inline.
All tables live in one TablesDB database. Clients never receive create/update/delete permissions;
every write goes through server code holding the API key.

## `programs`

A lottery-run program (e.g. a summer camp season). Drafts: organisers only. Published: anyone (row grant read("any")). Demo sandboxes (namespace "demo"): their visitor only, through a per-sandbox Team.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `org_team_id` | varchar(36) | yes | Appwrite Team ID whose members organise this program. |
| `name` | varchar(128) | yes | Display name. |
| `timezone` | varchar(64) | yes | ADDITION: IANA timezone for window times and age-at-week-start. |
| `window_open` | datetime | yes | Application window opens. |
| `window_close` | datetime | yes | Application window closes (freeze). |
| `max_weeks` | integer [1..12] | yes | K: max weeks per child (snake-draft rounds). |
| `drand_round` | integer [0..] | no | Future drand round announced at window open (set once, at publish). |
| `drand_chain` | varchar(64) | no | ADDITION (Task 10): hash of the drand chain the announced round belongs to (pinned, see shared/freeze/drand.ts). |
| `inputs_hash` | varchar(64) | no | SHA-256 of frozen draw inputs, published at freeze. |
| `status` | enum(draft \| open \| frozen \| drawn \| closed) | yes | Lifecycle state. |
| `synthetic` | boolean | yes | ADDITION: true for demo data; UI labels it as synthetic. |
| `description` | text | no | ADDITION: public description shown in the catalogue. |
| `default_tier` | integer [0..9] | no | ADDITION: tier for homes outside every priority zone. |
| `tier_labels` | text | no | ADDITION: JSON object of tier number to public label, e.g. {"0":"Priority zone","1":"Everyone else"}. |
| `published_at` | datetime | no | ADDITION: when the organiser published the catalogue (server time). |
| `source_note` | varchar(256) | no | ADDITION: data provenance shown to users, e.g. "Synthetic demo catalogue". |
| `late_policy` | enum(none \| accept_late) | no | ADDITION: whether submissions after window_close are accepted until freeze (late applicants rank after on-time ones). Null = none. |
| `offers_issued_at` | datetime | no | ADDITION (Task 11): Appwrite server time the draw offers were issued (their 48 h clock starts here). Families can respond only once set. |
| `offers_swept_at` | datetime | no | ADDITION (Task 11): server time of the last completed expiry/promotion sweep. |
| `namespace` | enum(production \| demo) | no | ADDITION (Task 12): "demo" marks a judge-sandbox program (synthetic, demo timing, private to its visitor). Null = production. Enforced server-side in both directions (functions/shared/namespace.ts). |
| `sandbox_owner` | varchar(36) | no | ADDITION (Task 12): Appwrite user ID of the visitor who owns this demo sandbox. Null for production programs. |
| `demo_advanced_ms` | integer [0..] | no | ADDITION (Task 12): total demo time this sandbox has been fast-forwarded (its own deadlines moved earlier; the server clock is never changed). |

| Index | Type | Columns |
|---|---|---|
| `idx_status` | key | status |
| `idx_namespace` | key | namespace |
| `idx_sandbox_owner` | key | sandbox_owner |

## `seat_ledger`

Capped seat counter per (program, week, age group). Readable by anyone once the program is published.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `week` | varchar(16) | yes | Program-defined week code, e.g. "2027-W26". |
| `week_start` | datetime | yes | ADDITION: first day of the week; age is computed as of this date. |
| `age_group` | varchar(16) | yes | Age group code, e.g. "6-8". |
| `min_age` | integer [0..25] | yes | ADDITION: youngest eligible age (years, at week_start). |
| `max_age` | integer [0..25] | yes | ADDITION: oldest eligible age (years, at week_start). |
| `capacity` | integer [0..100000] | yes | Seats available. |
| `taken` | integer [0..100000] | yes | Seats taken; only changed via incrementRowColumn(max = capacity). |
| `label` | varchar(64) | no | ADDITION: human-friendly session name, e.g. "Week 1: Jun 14-18". |

| Index | Type | Columns |
|---|---|---|
| `uq_program_week_age` | unique | program_id, week, age_group |

## `zones`

Priority-zone polygons per program, [longitude, latitude] rings. Readable by anyone once published.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `name` | varchar(64) | yes | Zone label. |
| `tier` | integer [0..9] | yes | Priority tier (lower draws first). |
| `area` | polygon | yes | Zone boundary. |

| Index | Type | Columns |
|---|---|---|
| `idx_program` | key | program_id |
| `sp_area` | spatial | area |

## `families`

A household: guardians and children, independent of any program. (Migration 001 moved per-program fields to applications.) Row security: its guardians.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `created_by` | varchar(36) | yes | Appwrite user ID of the guardian who created the household. |
| `synthetic` | boolean | yes | ADDITION: true for generated demo households. |

| Index | Type | Columns |
|---|---|---|
| `idx_created_by` | key | created_by |

## `family_locations`

ADDITION: private home point, split from families because permissions are per row, not per column. Readable by the household only; organisers see tiers, not homes.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `family_id` | varchar(36) | yes | families.$id |
| `home` | point | yes | Home location as [longitude, latitude] (private). |

| Index | Type | Columns |
|---|---|---|
| `uq_family` | unique | family_id |

## `guardians`

Links Appwrite users to households. A user belongs to at most one household.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `user_id` | varchar(36) | yes | Appwrite user ID. |
| `family_id` | varchar(36) | yes | families.$id |
| `role` | enum(primary \| linked) | yes | ADDITION: household creator, or a guardian who joined by invite. |

| Index | Type | Columns |
|---|---|---|
| `uq_user` | unique | user_id |
| `idx_family` | key | family_id |

## `children`

A child in a household (private). Program tickets live in `tickets`.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `family_id` | varchar(36) | yes | families.$id |
| `first_name` | varchar(64) | yes | Given name (private; never published). |
| `last_name` | varchar(64) | yes | ADDITION: family name, part of child_key to reduce false duplicate matches. |
| `birthdate` | datetime | yes | Date of birth (private; never published). |

| Index | Type | Columns |
|---|---|---|
| `idx_family` | key | family_id |

## `tickets`

ADDITION (brief: "the child is the ticket"): one lottery entry per child per program. UNIQUE(program_id, child_key) blocks a second ticket from another account or household.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `child_id` | varchar(36) | yes | children.$id |
| `family_id` | varchar(36) | yes | families.$id |
| `child_key` | varchar(64) | yes | HMAC-SHA256(server secret, normalised name + birthdate + program). Not reversible without the secret. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_child_key` | unique | program_id, child_key |
| `uq_program_child` | unique | program_id, child_id |
| `idx_family` | key | family_id |

## `applications`

ADDITION: a household's lottery entry for one program (the per-program part of the brief's families table).

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `family_id` | varchar(36) | yes | families.$id |
| `public_id` | varchar(32) | yes | Pseudonymous public identifier used in draw inputs and audit. |
| `claimed_tier` | integer [0..9] | no | Tier from the zone containing the claimed home. |
| `verified_tier` | integer [0..9] | no | Tier after organiser residency verification. |
| `near_boundary` | boolean | no | ADDITION: home within 50 m of a zone edge; flags verification. |
| `sibling_mode` | enum(together_only \| together_preferred \| independent) | yes | How siblings are placed. |
| `status` | enum(draft \| submitted \| withdrawn) | yes | ADDITION: application lifecycle. |
| `submitted_at` | datetime | no | ADDITION: server time of first submission. Never used for ordering within a tier. |
| `late` | boolean | no | ADDITION: submitted after window_close under an accept_late policy; ranks after on-time applicants. |
| `synthetic` | boolean | yes | ADDITION: true for generated demo applications. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_family` | unique | program_id, family_id |
| `uq_program_public_id` | unique | program_id, public_id |
| `idx_program_status` | key | program_id, status |

## `guardian_invites`

ADDITION: single-use codes that let a second guardian join a household. Only the code hash is stored. Server only.

- Row security: **off**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `family_id` | varchar(36) | yes | families.$id |
| `code_hash` | varchar(64) | yes | SHA-256 of the invite code; the code itself is shown once to the inviter. |
| `created_by` | varchar(36) | yes | Inviting guardian. |
| `expires_at` | datetime | yes | Invite expiry (72 h). |
| `status` | enum(pending \| accepted \| revoked) | yes | Invite lifecycle. |
| `accepted_by` | varchar(36) | no | User who accepted. |

| Index | Type | Columns |
|---|---|---|
| `uq_code_hash` | unique | code_hash |
| `idx_family` | key | family_id |

## `link_requests`

ADDITION: raised when a guardian tries to register a child who already has a ticket in another household. Readable by the EXISTING household only; carries no details about the requester.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `family_id` | varchar(36) | yes | Existing household that holds the ticket. |
| `ticket_id` | varchar(36) | yes | tickets.$id of the existing ticket. |
| `requester_hash` | varchar(64) | yes | SHA-256 of the requesting household ID: deduplicates requests without exposing who asked. |
| `status` | enum(open \| dismissed) | yes | Whether the existing household has acted on it. |

| Index | Type | Columns |
|---|---|---|
| `uq_ticket_requester` | unique | ticket_id, requester_hash |
| `idx_family` | key | family_id |

## `preferences`

Ranked weeks per child per program.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `child_id` | varchar(36) | yes | children.$id |
| `family_id` | varchar(36) | yes | families.$id |
| `program_id` | varchar(36) | yes | ADDITION: programs.$id. |
| `ranked_weeks` | varchar(16)[] | yes | Week codes, most preferred first. |
| `ranked_age_groups` | varchar(16)[] | no | ADDITION: age group for each ranked week, computed server-side from the birthdate at submission so draw inputs need no birthdates. |
| `requested_weeks` | integer [1..12] | yes | How many weeks the family wants for this child (<= max_weeks). |
| `held_weeks` | integer [0..12] | no | ADDITION (Task 11): weeks this child holds (offered or accepted). Set when offers are issued, then changed only by capped increment (max = requested_weeks) / decrement (min = 0) in the same transaction as the placement change. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_child` | unique | program_id, child_id |

## `placements`

A seat held by a child for a week. UNIQUE(program_id, child_id, week) prevents double placement.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | ADDITION: programs.$id. |
| `child_id` | varchar(36) | yes | children.$id |
| `family_id` | varchar(36) | yes | ADDITION: families.$id, so guardians can list a family's placements. |
| `ledger_id` | varchar(36) | yes | ADDITION: seat_ledger.$id whose taken counter this placement holds. |
| `week` | varchar(16) | yes | Program-defined week code, e.g. "2027-W26". |
| `age_group` | varchar(16) | yes | Age group code, e.g. "6-8". |
| `status` | enum(offered \| accepted \| declined \| expired \| released \| cancelled) | yes | Offer lifecycle. |
| `expires_at` | datetime | no | Offer expiry (48 h). |
| `draw_run_id` | varchar(36) | no | ADDITION: draw_runs.$id that created it. |
| `round` | integer [1..12] | no | ADDITION: snake-draft round. |
| `offered_at` | datetime | no | ADDITION (Task 11): Appwrite server time the offer was issued; expires_at = offered_at + 48 h. |
| `responded_at` | datetime | no | ADDITION (Task 11): server time (Operator.dateSetNow) of the transition out of the current state. |
| `source` | enum(draw \| waitlist) | no | ADDITION (Task 11): how the offer was made. Null = draw. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_child_week` | unique | program_id, child_id, week |
| `idx_program_week_status` | key | program_id, week, status |
| `idx_family` | key | family_id |
| `idx_status_expires` | key | status, expires_at |

## `waitlist`

Strict lottery-order waitlist per (program, week, age group).

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `week` | varchar(16) | yes | Program-defined week code, e.g. "2027-W26". |
| `age_group` | varchar(16) | yes | Age group code, e.g. "6-8". |
| `family_id` | varchar(36) | yes | families.$id |
| `child_id` | varchar(36) | yes | ADDITION: children.$id; waitlisting is per child. |
| `position` | integer [1..1000000] | yes | Lottery-order position. |
| `status` | enum(waiting \| promoted \| removed) | yes | ADDITION: entry lifecycle. |
| `rank` | integer [0..1000000] | no | ADDITION (Task 11): the family's position in the draw's lottery order (plan.order), so promotion can merge a week's age-group lists in strict lottery order. |

| Index | Type | Columns |
|---|---|---|
| `uq_slot_child` | unique | program_id, week, age_group, child_id |
| `uq_slot_position` | unique | program_id, week, age_group, position |
| `idx_program_status` | key | program_id, status |

## `overrides`

Pre-freeze organiser overrides with reason codes; hashed into inputs and counted publicly.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | ADDITION: programs.$id. |
| `family_id` | varchar(36) | yes | families.$id |
| `reason_code` | enum(accommodation \| sibling_enrolled \| staff_family \| policy_exception) | yes | Why the override exists. No free text, so no PII. |
| `pool` | enum(general \| accommodation) | yes | Seat pool the override draws from. |
| `created_before_freeze` | boolean | yes | Set by server time, never by the client. Re-checked after commit against the published snapshot (functions/shared/console.ts). |
| `created_by` | varchar(36) | yes | ADDITION: organiser user ID (the authorised actor). The timestamp is the row's server-set $createdAt. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_family` | unique | program_id, family_id |

## `staff_actions`

ADDITION (Task 12): log of every privileged organiser change (overrides, tier verification, capacity, freeze, demo time travel), written in the same transaction as the change. Names the actor, so it is readable by the program's organiser team only; a pseudonymous copy goes to the public audit_log.

- Row security: **on**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `actor_id` | varchar(36) | yes | Appwrite user ID of the organiser (or demo visitor) who made the change. |
| `action` | varchar(48) | yes | What was done, e.g. "override_created". |
| `target` | varchar(64) | no | Pseudonymous target: an application public ID, a session code or a ticket ref. Never a name. |
| `reason_code` | varchar(32) | no | Reason code from a fixed list (no free text). |
| `detail` | text | no | Canonical JSON with before/after values (pseudonymous only). |
| `audit_seq` | integer [1..] | no | seq of the public audit_log entry written with it. |

| Index | Type | Columns |
|---|---|---|
| `idx_program` | key | program_id |

## `draw_runs`

Resumable draw executions. Public.

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `status` | enum(pending \| running \| completed \| failed) | yes | Run state. |
| `drand_round` | integer [0..] | yes | drand round that seeds this run. |
| `seed` | varchar(128) | no | ADDITION: drand randomness (hex) once fetched. |
| `inputs_hash` | varchar(64) | yes | Inputs hash the run was computed from. |
| `plan_hash` | varchar(64) | no | ADDITION: SHA-256 of the computed placement plan, for replay comparison. |
| `cursor` | integer [0..] | yes | Next plan step to commit (resume point). |
| `started_at` | datetime | no | ADDITION. |
| `finished_at` | datetime | no | ADDITION. |
| `error` | varchar(256) | no | ADDITION: failure summary (no PII). |
| `seed_scheme` | varchar(32) | no | ADDITION (Task 10): how seed was derived from the beacon, e.g. even-odds-seed-v1. |
| `drand_chain` | varchar(64) | no | ADDITION (Task 10): drand chain hash of the beacon. |
| `beacon_randomness` | varchar(64) | no | ADDITION (Task 10): verified drand randomness (hex) for drand_round. |
| `beacon_signature` | varchar(192) | no | ADDITION (Task 10): drand BLS signature (hex) for drand_round, as fetched. |
| `beacon_verified` | boolean | no | ADDITION (Task 10): true once the beacon signature verified against the pinned chain key. |
| `beacon_verified_at` | datetime | no | ADDITION (Task 10): server time of verification. |
| `beacon_verifier` | varchar(64) | no | ADDITION (Task 10): verifier used, e.g. drand-client 1.4.2 (bls-unchained-g1-rfc9380). |
| `beacon_attempts` | integer [0..100000] | no | ADDITION (Task 10): fetch/verify attempts so far. |
| `beacon_last_error` | varchar(256) | no | ADDITION (Task 10): why the last attempt did not produce a verified beacon (draw stays pending). |

| Index | Type | Columns |
|---|---|---|
| `idx_program` | key | program_id |

## `frozen_inputs`

ADDITION (Task 10): the canonical draw inputs frozen when applications close, one row per program, written once inside the freeze transaction. Public, pseudonymous only (no names, birthdates, homes, family or user IDs).

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `format` | varchar(48) | yes | Canonical serialization format, e.g. even-odds-frozen-inputs-v1. |
| `algorithm` | varchar(48) | yes | Draw algorithm the inputs were frozen for, e.g. even-odds-draw-v1. |
| `inputs_hash` | varchar(64) | yes | SHA-256 (hex) of the UTF-8 bytes of `canonical`; equals programs.inputs_hash. |
| `canonical` | longtext | yes | The exact canonical serialization that was hashed (docs/FREEZE-PROTOCOL.md). |
| `frozen_at` | datetime | yes | Server time the freeze transaction was built. |
| `applications` | integer [0..] | yes | Public record count: applications in the inputs. |
| `children` | integer [0..] | yes | Public record count: children (tickets) in the inputs. |
| `sessions` | integer [0..] | yes | Public record count: sessions (capacity snapshot). |
| `seats` | integer [0..] | yes | Total capacity across sessions. |
| `overrides` | integer [0..] | yes | Approved pre-freeze overrides in the inputs. |
| `override_counts` | varchar(512) | yes | JSON object reason_code -> count (categories only, no families). |
| `drand_chain` | varchar(64) | yes | drand chain hash of the pre-announced round. |
| `drand_round` | integer [1..] | yes | The pre-announced drand round that will seed the draw. |
| `drand_round_at` | datetime | yes | When that round is due (genesis + (round - 1) x period). |
| `application_order` | longtext | no | ADDITION (Task 13): canonical JSON array of the frozen applications (public IDs) in submission order (no timestamps), committed in the freeze transaction. Not a draw input; used by the fairness report. Null for programs frozen before Task 13. |
| `application_order_hash` | varchar(64) | no | ADDITION (Task 13): SHA-256 of `application_order`; also in the inputs_frozen audit payload. |

| Index | Type | Columns |
|---|---|---|
| `uq_program` | unique | program_id |

## `draw_results`

ADDITION (Task 13): the published draw result, one row per program, written once after the draw commits: the placements and initial waitlist read back from the committed rows, as pseudonymous canonical JSON (even-odds-result-v1, docs/REPLAY.md). Public; the browser replay compares it with its own recomputation.

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `format` | varchar(48) | yes | Canonical format, e.g. even-odds-result-v1. |
| `canonical` | longtext | yes | The exact canonical text that was hashed. |
| `result_hash` | varchar(64) | yes | SHA-256 (hex) of the UTF-8 bytes of `canonical`; also in the result_published audit entry. |
| `draw_run_id` | varchar(36) | yes | draw_runs.$id whose placements this is. |
| `inputs_hash` | varchar(64) | yes | Inputs hash of the draw run. |
| `plan_hash` | varchar(64) | yes | Plan hash the draw run recorded. |
| `placements` | integer [0..] | yes | Public record count: placements in the result. |
| `waitlist` | integer [0..] | yes | Public record count: waitlist entries in the result. |
| `published_at` | datetime | yes | Server time the result was published. |
| `outcomes` | longtext | no | Live JSON (not hashed): current offer status per placement and waitlist entry, refreshed by the offers job. Pseudonymous. |
| `outcomes_at` | datetime | no | Server time of the last outcomes refresh. |

| Index | Type | Columns |
|---|---|---|
| `uq_program` | unique | program_id |

## `offer_stats`

ADDITION (Task 11): public, pseudonymous aggregate offer and waitlist counts per session, recomputed by the offers job from placements and waitlist. Display only; never used for seat decisions (seat_ledger is authoritative).

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `week` | varchar(16) | yes | Program-defined week code, e.g. "2027-W26". |
| `age_group` | varchar(16) | yes | Age group code, e.g. "6-8". |
| `capacity` | integer [0..100000] | yes | Copied from seat_ledger.capacity. |
| `taken` | integer [0..100000] | yes | Copied from seat_ledger.taken (seats held by pending or accepted offers). |
| `pending` | integer [0..100000] | yes | Offers awaiting a reply. |
| `accepted` | integer [0..100000] | yes | Accepted offers. |
| `waiting` | integer [0..1000000] | yes | Children still on the waitlist. |
| `promoted` | integer [0..1000000] | yes | Waitlist entries that received an offer. |
| `computed_at` | datetime | yes | Server time of the recount. |

| Index | Type | Columns |
|---|---|---|
| `uq_session` | unique | program_id, week, age_group |

## `audit_log`

Public, append-only, hash-chained event log. Pseudonymous identifiers only.

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `seq` | integer [1..] | yes | ADDITION: position in the chain; UNIQUE per program prevents forks. |
| `event` | varchar(64) | yes | Event name, e.g. "inputs_frozen". |
| `payload` | text | yes | ADDITION: canonical JSON payload (pseudonymous IDs only). |
| `payload_hash` | varchar(64) | yes | SHA-256 of payload. |
| `prev_hash` | varchar(64) | yes | Hash of the previous entry ("0"*64 for the first). |
| `entry_hash` | varchar(64) | yes | ADDITION: SHA-256(prev_hash \|\| seq \|\| event \|\| payload_hash); the next entry's prev_hash. |

| Index | Type | Columns |
|---|---|---|
| `uq_program_seq` | unique | program_id, seq |
| `idx_program_event` | key | program_id, event |

## `odds_snapshots`

ADDITION: the latest published odds estimate per program (aggregates only: per-tier bands and per-session demand). Public; one row per program, updated at most hourly, frozen 24 h before close.

- Row security: **off**
- Table permissions: `read("any")`

| Column | Type | Required | Meaning |
|---|---|---|---|
| `program_id` | varchar(36) | yes | programs.$id |
| `computed_at` | datetime | yes | When this estimate was computed (server time). |
| `model_version` | varchar(32) | yes | Estimator version, e.g. odds-v1. |
| `iterations` | integer [0..1000000] | yes | Monte Carlo iterations. |
| `seed` | varchar(64) | yes | PRNG seed string, so the estimate can be reproduced. |
| `applicants` | integer [0..] | yes | Submitted applications counted. |
| `children` | integer [0..] | yes | Children across those applications. |
| `seats` | integer [0..] | yes | Total capacity across sessions. |
| `tiers` | text | yes | JSON array of per-tier odds (small tiers suppressed). |
| `sessions` | text | yes | JSON array of per-session demand. |
| `frozen` | boolean | yes | True once the 24-hour pre-close freeze applies; no further updates. |
| `freeze_at` | datetime | yes | window_close minus 24 hours. |

| Index | Type | Columns |
|---|---|---|
| `uq_program` | unique | program_id |

## `idempotency`

ADDITION (brief: "idempotency per (family, round)"): one row per completed request, written in the same transaction as its effect.

- Row security: **off**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `scope` | varchar(32) | yes | Operation family, e.g. "place". |
| `program_id` | varchar(36) | yes | programs.$id |
| `key_hash` | varchar(64) | yes | SHA-256 of the caller-supplied idempotency key. |
| `result` | text | no | JSON summary of the committed result, returned on replay. |

| Index | Type | Columns |
|---|---|---|
| `uq_scope_key` | unique | scope, key_hash |

## `sandboxes`

ADDITION (Task 12): registry of judge-demo sandboxes, one per visitor. Server only: the browser never names a sandbox; the api derives it from the caller. Resets move to a new generation (a fresh program ID) and delete the old one.

- Row security: **off**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `owner_id` | varchar(36) | yes | Appwrite user ID of the visitor (usually an anonymous session). |
| `team_id` | varchar(36) | yes | Per-sandbox Appwrite Team (random ID) whose only member is the visitor; grants read on the sandbox rows. |
| `program_id` | varchar(36) | yes | The current generation's demo program ID. |
| `generation` | integer [1..1000000] | yes | Increments on every reset. |
| `status` | enum(seeding \| ready) | yes | seeding = the current generation is being written (a retry resumes it). |
| `reset_count` | integer [0..1000000] | yes | Resets in the current rate-limit window. |
| `reset_window_start` | datetime | yes | Start of the current rate-limit window. |
| `last_active_at` | datetime | yes | Last demo request; idle sandboxes are removed by the jobs Function. |
| `ip_hash` | varchar(64) | no | ADDITION (Task 14): keyed hash (HMAC) of the creating client IP; limits active sandboxes per network. The address itself is not stored. |

| Index | Type | Columns |
|---|---|---|
| `uq_owner` | unique | owner_id |
| `idx_last_active` | key | last_active_at |
| `idx_ip_hash` | key | ip_hash |

## `rate_limits`

ADDITION (Task 14): fixed-window request counters for sensitive api actions, one row per (bucket, caller, window). The cap is enforced by incrementRowColumn({ max }), the same verified primitive that caps seats. Server only; old windows are deleted by the jobs Function.

- Row security: **off**
- Table permissions: none (server only, or per-row grants)

| Column | Type | Required | Meaning |
|---|---|---|---|
| `bucket` | varchar(32) | yes | Limited action group, e.g. "identity". |
| `subject_hash` | varchar(64) | yes | SHA-256 of the caller's user ID (no raw IDs stored). |
| `window_start` | datetime | yes | Start of the fixed window this row counts. |
| `count` | integer [0..1000000] | yes | Requests counted in the window (capped at the bucket limit). |

| Index | Type | Columns |
|---|---|---|
| `idx_window_start` | key | window_start |
