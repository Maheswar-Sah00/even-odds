# Verified Appwrite behaviour

Everything below was **observed on Appwrite Cloud** (region `sfo`, Free plan,
API response format 2.5.0, `node-appwrite` 31.0.0, `appwrite` 29.1.0) on
2026-10-25, unless marked otherwise. Each row names the test that re-checks it;
run `npm run test:integration` to reproduce. Nothing in this file comes from a
mocked response.

## Capped counters and transactions (critical experiment)

| # | Experiment | Observed result | Test |
|---|---|---|---|
| A | `incrementRowColumn({ value: 1, max: 1 })` from 0 | Succeeds, `taken = 1` | `invariants › A–F direct increment` |
| A | Same call again at 1 | **Throws `400 column_limit_exceeded`** ("Column "taken" has reached the maximum value of 1"); `taken` stays 1 | same |
| — | Generic `updateRow({ taken: Operator.increment(1, 1) })` at the cap | **No error, no change** (silent no-op). Never used for seats. | `invariants › CONTRAST` |
| D | Capped increment **staged** in a transaction on a full ledger | Staging call **succeeds** and returns a mock value | `invariants › staged in a transaction` |
| F | Commit of that transaction | **Throws `400 attribute_limit_exceeded`** ("Attribute value exceeds maximum limit: 1"); transaction status `failed`; counter unchanged | same |
| G | Sibling group: ledger A has room, ledger B full, both increments + both placement rows in one transaction | Commit fails with `attribute_limit_exceeded`; **A.taken stays 0, no placements created**: whole group rolled back | `invariants › G rolls back the whole family` |
| B/E | 20 concurrent `placeGroup` calls on a capacity-3 ledger | **Exactly 3 placed, 17 `no_capacity`, taken = 3, 3 placement rows** (earlier exploratory run: 12 on capacity 1 → exactly 1) | `invariants › 20 concurrent placements` |
| H | Unique-index violation `(child_id, week)` **inside a transaction** | Commit fails with **`409 transaction_conflict`** (not `row_already_exists`) and rolls back, including the staged increment | `invariants › cannot be placed twice` |
| H | Same violation **outside** a transaction | `409` (`row_already_exists` family of errors), mapped to `conflict` | `invariants › unique index alone` |
| H | Two transactions `updateRow` the same row, committed in turn | First commits; second **`409 transaction_conflict`**; a fresh retry transaction then commits | `invariants › genuine optimistic conflict` |
| — | Two transactions each `incrementRowColumn` the same row | **Both commit** (increments are not treated as conflicting); the cap still applies at commit | exploratory run (see below) |
| H | Same idempotency key sent once, then again | Second call returns `replayed` with the original placement IDs; no extra seat | `invariants › repeating a request` |
| H | Same request sent 5× simultaneously | Exactly one `placed`, the rest `replayed`; taken = 1 | `invariants › 5 simultaneous duplicates` |

### Design consequences

1. Seats are only ever taken with `incrementRowColumn({ max: capacity })`
   staged in a transaction (`functions/shared/placement.ts`). Capacity is read
   from the ledger row on the server, never from the caller.
2. Because staging returns mock values, results are taken from a **post-commit
   re-read**, which also asserts `taken <= capacity`.
3. Because a unique violation and an optimistic conflict both appear as
   `transaction_conflict` at commit, `placeGroup` **re-reads** the idempotency
   row and the deterministic placement rows to tell them apart, and only
   retries (full-jitter backoff) when neither exists.
4. Fallback direction (Roll Call) is **not** needed: the documented operation
   enforces the invariants on the target environment.

## Schema and platform features

| Feature | Observed | Where |
|---|---|---|
| `point` and `polygon` columns, `spatial` index | Created and `available` on the Free plan | `npm run db:provision` |
| Required `varchar` **array** column | Accepted | `preferences.ranked_weeks` |
| Enum column type in API responses | `type: "string"`, `format: "enum"` | provisioning drift check |
| Integer with no `max` | Reported as `max = 9223372036854775807` | provisioning drift check |
| Column/index creation | Asynchronous (`processing` → `available`); full schema ≈ 65 s | provisioning |
| Server-created team membership (`teams.createMembership({ userId })`) | Effective immediately; team role grants row reads | `permissions` |
| Server-created session (`users.createSession`) | Returns a `secret` usable with `Client.setSession` in the browser SDK | `permissions` |

## Permissions and errors

| Case | Observed |
|---|---|
| Guest lists a row-security table with no table grants (`families`) | `200`, zero rows (rows are filtered, not refused) |
| Guest lists a table with no grants and no row security (`idempotency`) | `401 user_unauthorized` |
| Guest create/update/delete on a public-read table | `401` |
| Signed-in family reads another family's row by ID | `404` (existence not revealed) |
| Organiser (team member) reads `family_locations` | `404` |
| Users/organisers update or delete `audit_log` rows | `401` |
| Wrong project ID | `404 project_not_found` |
| Invalid API key | `401 api_key_invalid` |
| Unreachable endpoint / DNS failure | `TypeError: fetch failed` (Node) / `Failed to fetch` (browser) → `network` |
| Database missing | `404 database_not_found` |
| Browser on `localhost` after registering a Web app | CORS passes; status page shows "Connected to Appwrite" |


## Functions runtime (Task 5)

Observed with a temporary probe Function (since deleted) and the deployed `household` Function. Re-checked by `tests/integration/household-function.test.ts`.

| Case | Observed |
|---|---|
| Runtime | `node-22`; a single bundled `main.js` (Vite SSR build) with no install step deploys to `ready` in about 10 s |
| Caller identity | `x-appwrite-user-id` holds the real caller; absent for guests; `x-appwrite-user-jwt` also present |
| Client tries to send `x-appwrite-user-id` (or any `x-appwrite-*` header) | **Rejected by the platform with `400 general_argument_invalid`** before the Function runs, so the caller ID cannot be forged |
| Dynamic API key | `x-appwrite-key` is present on every execution and is limited to the Function's configured scopes; works with TablesDB and Users |
| Built-in env | `APPWRITE_FUNCTION_API_ENDPOINT`, `APPWRITE_FUNCTION_PROJECT_ID` |
| Outbound HTTPS from a Function | Works (`https://api.drand.sh/public/latest` returned 200) |
| Sync execution latency | about 3.5 s cold, about 0.45 s warm |
| Guest executing a Function with `execute: ["users"]` | `401` |
| `updateRow` with empty `data` and only `permissions` | Accepted: used to re-grant household access when a guardian joins |
| Server API version reported in errors | `2.6.1` |

## Email one-time codes (Task 5)

Re-checked by `tests/integration/auth-otp.test.ts`. Email delivery itself is checked manually (see README).

| Case | Observed |
|---|---|
| `account.createEmailToken` for an email that already has an account | Returns that **existing** user's ID (the `userId` argument is ignored), `secret: ""`, `expire` 15 minutes ahead |
| Invalid email | `400 general_argument_invalid` |
| Correct code → `account.createSession({ userId, secret })` | Session created |
| Wrong code, **already-used** code, **expired** code, unknown user | **All the same: `401 user_invalid_token`**. The client tells them apart using the token's `expire` time and its own record of codes it has already used successfully |

## Migration 001

`npm run db:migrate:001 -- --apply` deleted the four reshaped tables after confirming each had 0 rows, and dropped two old unique indexes (no data). `npm run db:provision` then recreated everything; `db:check` reports 18 tables in sync.


## Geo columns and queries (Task 6)

Observed with a probe on Cloud and re-checked by `tests/integration/organiser.test.ts` (zone classification).

| Case | Observed |
|---|---|
| Point / polygon coordinate order | **[longitude, latitude]**. `Query.intersects('area', [lng, lat])` matched; the swapped `[lat, lng]` matched nothing |
| Unclosed polygon ring | Rejected: `400 row_invalid_structure` "Ring #0 must be closed" |
| Latitude outside ±90 | Rejected: `400 row_invalid_structure` |
| Point exactly on an edge or a corner | `intersects` returns the zone (boundary counts as inside) |
| Point 43 m outside a zone | `intersects`: no match; `distanceLessThan(.., 50, true)`: match; `distanceLessThan(.., 30, true)`: no match (metres are honoured) |
| Point inside a zone | `distanceLessThan(.., 1, true)` matches: **distance to an interior point is 0**, so "near the edge from inside" is computed in `shared/geo.ts` |
| Bulk `upsertRows` with per-row `$id` and `$permissions` | Works (sessions and zones import) |
| Row-security table, guest reading a row with only team grants | `404` (drafts are invisible); after publish adds `read("any")`, guests can read |
| Function variable IDs | Unique **per project**, not per function; IDs are prefixed with the function ID |


## Plan limits and Realtime (Task 8)

| Case | Observed |
|---|---|
| Creating a 3rd Function on the Free plan | **`403 additional_resource_not_allowed`**: the Free plan allows 2 Functions per project. Even Odds therefore deploys exactly two: `api` (all user requests, routed by `area`) and `jobs` (scheduled work) |
| Cron `schedule` on the Free plan | **`403 billing_feature_unsupported`**: "Use an interval instead". `jobs` uses `interval: 60` (minutes; Appwrite picks when within each hour it runs) |
| Realtime: guest browser subscribed to one public row (`Channel.tablesdb(db).table('odds_snapshots').row(id)`) | Server-side recompute pushed the new row to the open page with **no reload** (Playwright: `computed_at` changed, 0 navigations) |
| Bulk seeding with `upsertRows` (100 per request) vs one row at a time | 150 households in about 23 s vs 120 in about 5.5 min |

## Freeze and drand (Task 10)

Re-checked by `tests/integration/freeze.test.ts` (real TablesDB and the real drand network) and `tests/integration/freeze-function.test.ts` (deployed Functions).

| Case | Observed |
|---|---|
| `longtext` column (`createLongtextColumn`) on the Free plan | Created and `available`; reported as type `longtext`. Holds the canonical inputs, also when written inside a transaction |
| Datetime values read back | Returned as `2026-10-27T03:31:39.229+00:00`, not the `Z` form that was written; the protocol normalises to `Z` on read |
| 6 simultaneous freezes of one program (status update + deterministic-ID snapshot, draw run and audit entry in one transaction) | Exactly one commits; the other five do not, and return the committed snapshot (`already_frozen`); one snapshot, one draw run, one audit entry, chain intact |
| 4 simultaneous beacon resolutions | One seed and one `beacon_verified` entry (deterministic idempotency row in the same transaction) |
| drand relays `api.drand.sh`, `api2.drand.sh`, `drand.cloudflare.com` | Identical quicknet beacons; future round returns **HTTP 425**; `Access-Control-Allow-Origin: *`, so the browser verifier fetches directly |
| BLS verification (`drand-client` 1.4.2) inside the deployed `jobs` Function | Fetched round 1,000,000 from Appwrite Cloud, verified, derived the seed and completed the draw in one sync execution |
| `Query.isNull` / `Query.equal` on unindexed `draw_runs` columns | Works (filters without an index) |

## Offers and waitlist (Task 11)

Re-checked by `tests/integration/offer-primitives.test.ts` (the primitives),
`tests/integration/offers.test.ts` (the workflow under concurrency) and
`tests/integration/offers-function.test.ts` (the deployed `api` Function).

| Case | Observed |
|---|---|
| `decrementRowColumn({ value: 1, min: 0 })` staged in a transaction, counter at 1 | Commits; counter 0 |
| Same, counter already at 0 | Staging succeeds; **commit fails `400`, mapped `capacity_exceeded`**, and rolls back; counter stays 0 |
| One transaction decrements and another does a capped increment on the same ledger row | **Both commit** (counter ops do not conflict); final value correct |
| `transaction.$createdAt` | Appwrite server time, within seconds of the test machine; used as the trusted clock for offer issuance and validity |
| `Operator.dateSetNow()` in `updateRow` inside a transaction | Commits; the column holds the server time (used for `placements.responded_at`) |
| Bulk `updateRows({ data, queries })` | Updates only rows matching the queries when it runs; rows that no longer match are untouched (used to start offer clocks exactly once) |
| **Stale read**: A reads a row, B updates it and commits, then A stages its own update in a NEW transaction | **A commits too and silently overwrites B** (no conflict). A status read is therefore never a guard |
| Same, but each writer also creates the same deterministic "exit marker" row in its transaction | The second commit fails **`409 transaction_conflict`** and rolls back. Offer transitions use one marker per (placement, state left) |
| 8 concurrent accepts of one offer (4 sharing one idempotency key) | Exactly one commit; the rest return `replayed` / `unchanged`, all reporting `accepted`; seat count unchanged |
| Accepts racing declines on one offer | Exactly one transition commits; seat released at most once |
| 2 families x 2 attempts at the last seat (`placeGroup`) | Exactly one `placed`; `taken = capacity` |
| 3 `expireDueOffers` + 2 full sweeps at once over 6 expired offers | Each offer expired once (one exit and one release marker each); `taken` 6 -> 0 |
| 5 simultaneous sweeps over a contested week (3 + 2 seats; singles, together_only and together_preferred siblings) | Exactly the strict-lottery-order outcome; no seat twice; `taken` = holding offers <= capacity; `held_weeks` <= requested |
| One child waitlisted in two free weeks, promotions for both weeks at once | Promoted into exactly one (`held_weeks` capped at `requested_weeks`) |
| Same idempotency key sent twice at once to the deployed `api` Function | One `changed`, one `replayed` |

## Judge sandbox (Task 12)

Re-checked by `tests/integration/sandbox.test.ts`, `npm run smoke:demo` (deployed
Function) and `npm run test:e2e:live` (real browser). See [JUDGE-DEMO.md](JUDGE-DEMO.md).

| Case | Observed |
|---|---|
| `POST /account/sessions/anonymous` on this project | `201`, a guest user and session (`provider: "anonymous"`); `execute: ["users"]` Functions accept it |
| Synchronous execution running past 30 s | Fails: "Synchronous function execution timed out". Every demo action is time-boxed and resumable |
| `teams.create` with an ID that already exists | `409`; two concurrent first opens of one sandbox both succeed after treating it as "the other won" |
| Sandbox rows granted `read(team:<sandbox team>)` | The visitor reads them through the browser SDK; another signed-in user gets `404` |
| Sibling pair into a week whose 8-10 group is full (5-7 has room), both increments staged in one transaction | Commit refused (`attribute_limit_exceeded`, mapped `capacity_exceeded`); both ledgers unchanged; no placement rows |
| Second ticket for the same child from another household | `createRow(tickets)` refused by `uq_program_child_key` (`409`); tickets for the child stay 1 |
| Demo draw, seeded by a live quicknet round announced 45 s after the fast-forwarded close | Beacon verified, draw committed, 0 oversold, 0 sibling splits; the browser replay passes all seven checks |
| Demo 48 h fast-forward: pending offers' `expires_at` moved by exactly -48 h | The real sweep expires every one of them (server time >= `expires_at`); seat counts equal holding offers |
| Reset | New generation seeded; every row of the old generation (16 tables + synthetic households) deleted; another visitor's sandbox untouched |

## Load, races and abuse limits (Task 14)

Re-checked by `npm run test:stress` (`tests/stress/seat-integrity.test.ts`; raw
evidence in `docs/test-evidence/stress/`) and `tests/integration/security.test.ts`.
Full results and run history: [TEST-REPORT.md](TEST-REPORT.md).

| Case | Observed |
|---|---|
| A burst of 500 simultaneous requests with the **server API key** | Appwrite Cloud answers part of it with **`429 general_rate_limit_exceeded`**. The share varied by run: 1 of 500, then 235 of 500, then 131 of 500 in the first wave. After about an hour of sustained load the endpoint briefly refused connections (`fetch failed`). The suite therefore retries 429s with jittered backoff (up to 12 times), as clients do |
| Two copies of the SAME placement request racing for the LAST seat | The first commits; the second's commit fails with `attribute_limit_exceeded` (capacity), **not** `transaction_conflict`, because the cap is checked before the unique index. `placeGroup` used to report `no_capacity` for it, which made overlapping draw workers fail the run. It now re-reads its idempotency row on a capacity refusal and reports `replayed` |
| 4 draw workers on one run (1 or 2 steps per call), plus a cursor reset mid-run | After the fix: all complete, placements exactly equal the plan; before it: the run failed at the first contested last seat (`diverged ... no_capacity`) |
| Email one-time codes (`account.createEmailToken`) from one machine | 10 codes sent, the 11th refused with `429`. A **different** email from the same machine minutes later was refused at once, so the limit is (at least partly) per IP address, about 10 an hour |
| Anonymous-style account (no email) calling the household area | Refused `403 forbidden` (server check added in Task 14) |
| Per-caller limit on invite attempts (`rate_limits` table, capped `incrementRowColumn`) | 10 attempts answered, the 11th and 12th `429` |
| Browser SDK in Node.js after `createAnonymousSession` | The session cookie is not kept (no cookie jar), so later calls are unauthenticated (`401`). Tests use server-created sessions (`users.createSession`) instead |

## Not yet verified (assumptions)

- Async executions for long-running jobs (the draw runs in time-boxed, resumable steps instead).
- Realtime with query filters, and behaviour near the 250-connection Free limit.
- Email OTP delivery to a real inbox, and whether the emailed code is always numeric (manual check).
- How transaction internals count against the monthly write quota.
- Behaviour at the Free plan's 100-operations-per-transaction limit.
