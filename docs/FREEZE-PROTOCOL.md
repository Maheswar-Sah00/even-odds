# Freeze and verify (Task 10)

How Even Odds commits to its inputs before randomness exists, takes that
randomness from drand, and lets anyone check the result. Code:

| Part | File |
|---|---|
| Canonical inputs format | [`shared/freeze/canonical.ts`](../shared/freeze/canonical.ts) |
| Pinned chain, round rule, seed derivation | [`shared/freeze/protocol.ts`](../shared/freeze/protocol.ts) |
| Beacon fetch and verification | [`shared/freeze/drand.ts`](../shared/freeze/drand.ts) |
| Audit hash chain | [`shared/audit-chain.ts`](../shared/audit-chain.ts) |
| Freeze, beacon and draw steps (server) | [`functions/shared/freeze.ts`](../functions/shared/freeze.ts) |
| Browser verifier | [`src/features/audit/verify.ts`](../src/features/audit/verify.ts) |

`shared/` files run unchanged on the server and in the browser
(`tests/e2e/freeze-parity.spec.ts` checks that both give identical bytes,
hashes, seeds and verification results).

## Timeline

```
publish ── applications open ── window_close ── freeze ──── round N due ── beacon verified ── draw ── drawn
   │                                   │          │              │                │
   └ round N announced                 │          └ inputs hash  └ drand          └ seed derived
     (fixed by window_close)           │            published      publishes N
                                       └ freeze allowed from here until N − 30 min
```

1. **Announce (publish).** The program commits to drand round
   `N = first quicknet round at or after window_close + 3 h`. N is a pure
   function of `window_close`, which can only be edited while the program is a
   draft, so N is fixed before any application exists and before N's output
   exists. It is stored on `programs.drand_round` / `drand_chain` and in the
   `program_published` audit entry. Programs published before this rule
   existed get N from the same rule on the next scheduled tick
   (`drand_round_announced` entry), only while the freeze deadline is still ahead.
2. **Freeze (after `window_close`, before `N − 30 min`).** See below. The
   `jobs` Function freezes due programs on its hourly tick; organisers can
   freeze from the program page as soon as applications close. With an
   `accept_late` policy the scheduled freeze waits until 75 minutes before
   the deadline, so late applications are accepted until then.
3. **Beacon (once N is due).** The `jobs` Function fetches round N, verifies
   it and derives the seed. Until then the draw stays pending.
4. **Draw.** Runs only from the published snapshot, with a seed whose
   provenance re-verifies (below).

## What is frozen

The draw inputs (`draw-inputs-v2` since Task 14; `draw-inputs-v1` earlier; docs/DRAW-ALGORITHM.md):

| Input | From |
|---|---|
| Pseudonymous application IDs (`publicId`) | `applications.public_id` (random, 128-bit) |
| Tier (verified, else claimed, else program default), `late`, sibling mode | `applications` |
| Per child: ticket ref, ranked weeks, age group per week, weeks requested | `tickets.$id`, `preferences` |
| Approved overrides: the receipt ID only (v1 also published reason category and pool) | `overrides` with `created_before_freeze = true` |
| Capacity snapshot: every session's capacity | `seat_ledger` |
| Algorithm version, program ID, max weeks | `programs`, the draw module |

Eligible = submitted applications with at least one child. Withdrawn and draft
applications are not included; the number of submitted applications without
children is logged (`excluded_without_children`).

Never included: names, birthdates, email, homes or coordinates, family,
household, child or user IDs, `child_key`, the child-key secret or any other
secret. The format is an allow-list: an unknown field is an **error**, not
silently dropped, so personal data cannot ride along by accident.

## Canonical serialization (`even-odds-frozen-inputs-v1`)

The published bytes are the UTF-8 encoding of JSON with these rules:

- **Fields**: exactly the documented fields of `DrawInputs` and its records;
  `withdrawn` appears only when `true` (absent and `false` cannot hash differently).
- **Keys**: sorted by UTF-16 code unit at every level.
- **Records**: `sessions` by (week, age group); `applications` and
  `overrides` by `publicId`; each application's `children` by `ref`; all by
  UTF-16 code unit (`<` in JavaScript, the draw module's comparator).
  `rankedWeeks` and `ageGroups` keep their order: that order is the preference.
- **Numbers**: integers only, decimal, no sign on zero, no exponent, no
  leading zeros. Ranges: tier 0–9, capacity 0–100000, requested and
  maxWeeks 1–12.
- **Identifiers** (IDs, week and age-group codes): 1–64 characters of
  `A–Z a–z 0–9 . _ -`, so they cannot carry spaces, `@` or other contact data.
- **Whitespace**: none. No trailing newline.
- **Dates**: none inside the hashed inputs. Times published beside them
  (`frozen_at`, round times) use ISO 8601 UTC with milliseconds and `Z`,
  e.g. `2027-02-10T14:00:00.000Z` (Appwrite returns `+00:00`; the protocol
  normalises on read).

A file is valid only if re-serializing it gives back **the identical text**
(`parseFrozenInputs`); pretty-printed, reordered or otherwise non-canonical
files are rejected, so one set of inputs has exactly one hash.

**Inputs hash** = lowercase hex SHA-256 of those bytes. It equals the draw
module's `inputsHash()` of the same inputs, so `programs.inputs_hash`,
`frozen_inputs.inputs_hash`, `draw_runs.inputs_hash` and the plan's
`inputsHash` are one value.

Example: the synthetic sample (`shared/draw/sample.ts`) serializes to 1,558
bytes beginning `{"algorithm":"even-odds-draw-v1","applications":[{"children":[{"ageGroups":["young","young"],...`
with hash `76eee619663c874628058d411046941184b65cf38ab3cb915a93034ebe95ceaf`.

## The freeze transaction

`freezeProgram` validates, serializes and hashes, then commits **one
TablesDB transaction** containing:

1. `programs`: `status open → frozen`, `inputs_hash` (through
   `transitionProgram`, the only status writer);
2. `frozen_inputs` row `fz…` (deterministic ID per program): the canonical
   text, hash, `frozen_at`, record counts, override counts by reason, round;
3. `draw_runs` row `dr…` (deterministic ID per program): `pending`, no seed;
4. `audit_log` entry `inputs_frozen` (hash-chained; next `seq`).

Idempotency and concurrency: the snapshot and draw-run IDs are fixed per
program, so a second transaction can never commit a second snapshot (it fails
with `transaction_conflict` and rolls back entirely). Every caller, repeated
or concurrent, re-reads and receives the one committed snapshot
(`status: "already_frozen"`). `tests/integration/freeze.test.ts` runs 6
simultaneous freezes: one snapshot, one draw run, one audit entry.

Refusals (`423 locked`): before `window_close`; with no announced round, a
round that does not match the rule, or another chain; after the freeze
deadline (`N − 30 min`): the round can never be changed, so a missed deadline
leaves the program unfrozen for a human to handle rather than pick a new round.
Invalid inputs give `400 validation` with the problems listed.

After the freeze, application submit/edit/withdraw, ticket registration and
capacity changes are refused server-side (they require `status = open`), and
the status cannot move back. The draw reads the **published snapshot**, not
live rows, so even a later direct edit by an API-key holder cannot change the
inputs of the draw. If rows read back right after the commit already differ
(a late write racing the freeze), `inputs_changed_after_freeze` is logged; the
snapshot stays authoritative.

## Randomness

**Chain (pinned in code):** drand mainnet *quicknet*, chain hash
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, scheme
`bls-unchained-g1-rfc9380`, period 3 s, genesis 1692803367, and its group
public key. Chain info served over the network is never used for
verification. Round `r` is due at `genesis + (r − 1) × 3` seconds.

**Fetch:** `GET https://{api.drand.sh | api2.drand.sh | drand.cloudflare.com}/<chain hash>/public/<N>`,
relays tried in turn. HTTP 425 means the round does not exist yet. Relays
are not trusted: they can withhold a beacon but not forge one.

**Verify:** with `drand-client` 1.4.2 (the drand team's maintained client;
BLS12-381 via `@noble/curves`), through its own `fetchBeacon` verification
path against the pinned chain: the round must equal N, `randomness` must
equal SHA-256(`signature`), and the BLS signature over SHA-256(round as
8-byte big-endian) must verify under the group key.

**On failure** (invalid signature, wrong round, wrong chain, relays down, or
round not yet produced) the run stays `pending`, the attempt and reason are
recorded on `draw_runs` (`beacon_attempts`, `beacon_last_error`), and the
next tick tries again. There is no fallback: no `Math.random()`, no
timestamp, no other round.

**Seed (`even-odds-seed-v1`):**

```
seed = SHA-256( UTF-8( "even-odds-seed-v1" "\n" chainHash "\n" round "\n" randomness "\n" inputsHash "\n" programId ) )
```

Hex lowercase, round in decimal. Binding the inputs hash and program means a
beacon gives unrelated seeds to different programs, and a seed only fits the
inputs frozen before the round existed. Shell check (sample inputs, quicknet
round 1,000,000):

```sh
printf 'even-odds-seed-v1\n%s\n%s\n%s\n%s\n%s' \
  52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971 1000000 \
  b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3 \
  76eee619663c874628058d411046941184b65cf38ab3cb915a93034ebe95ceaf synthetic-sample | sha256sum
# 8491b17c464671c416cbf408ee4bd009820b71a946ec9164432031881ab39042
```

The seed, randomness, signature, verifier and verification time are stored
on `draw_runs` and in the `beacon_verified` audit entry, committed in one
transaction with a deterministic idempotency row, so concurrent resolvers
store one seed and one entry.

**Draw guard:** for a program frozen through this protocol, the `jobs`
Function draws only the run created at freeze, and only after re-verifying
the stored beacon offline and re-deriving the seed
(`seedProvenanceProblem`). A seed written any other way is refused.

## What is published

All public (readable by anyone, no sign-in) and pseudonymous:

| Where | What |
|---|---|
| `programs` | `drand_round`, `drand_chain`, `inputs_hash`, `status` |
| `frozen_inputs` | canonical inputs text, hash, `frozen_at`, format, algorithm, record counts, override counts per reason, round and due time |
| `draw_runs` | status, cursor, seed and seed scheme, beacon randomness and signature, verification result and verifier, attempts and last error, plan hash |
| `audit_log` | hash-chained events: `program_published` (with round), `drand_round_announced`, `inputs_frozen`, `inputs_changed_after_freeze`, `beacon_verified`, `draw_completed`, `draw_failed`, `result_published` (Task 13) |
| `frozen_inputs.application_order` | Task 13: public IDs in submission order (no timestamps), hashed into `inputs_frozen`; not a draw input |
| `draw_results` | Task 13: the committed placements and waitlist, read back from the database after the draw ([REPLAY.md](REPLAY.md)) |

Override **families** are not published as such: each override appears in the
inputs only as the pseudonymous `publicId`. Since Task 14 (`draw-inputs-v2`)
its reason and pool are **not** published, because a reason such as
`accommodation` (an aide, medical or access need) would be disclosed to anyone
holding the family's receipt code; the draw never used them (both pools rank
the same). Reasons stay in the organiser team's staff log, and public audit
entries for overrides and tier verifications carry no reason code. Programs
frozen under `draw-inputs-v1` (reason and pool included) still verify, and
their per-category counts are still shown.

Pages: `/audit/:programId` (status, hashes, counts, override categories,
chain checked in the browser, canonical file download) and
`/replay/:programId` ("Verify the published draw": every check below, then
the full plan).

## Verifying independently

The full replay, including the placement-by-placement comparison with the published result and the audit integrity report, is specified in [REPLAY.md](REPLAY.md).

In the browser: open `/replay/:programId` and press **Verify the published
draw**. It checks the audit chain; that the announced round follows the rule
and was logged at publish; that the downloaded canonical file is canonical
and hashes to the published hash, with matching counts; that the freeze
happened before the deadline (server time); fetches round N **directly from
drand**, verifies the signature, derives the seed, compares it with the
server's, recomputes the plan and compares its hash.

By hand: download the canonical file from the audit page; `sha256sum` it
(compare with `inputs_hash`); `curl` the beacon from any drand relay and
verify it with any drand implementation; derive the seed with the shell
command above; run `computePlan` from `shared/draw` on the file and seed and
compare `planHash` with `draw_runs.plan_hash`.

## Trust assumptions

- **drand / League of Entropy:** fewer than the threshold of drand nodes
  collude, so round N's value is unpredictable before it is produced. The
  pinned group key is the real quicknet key (it matches drand's published
  chain info and `drand-client`'s built-in constants).
- **Appwrite server time and storage:** `frozen_at`, `$createdAt` and the
  order of events are the platform's word. The protocol's claim that inputs
  were frozen before N existed rests on that time.
- **The operator's code is the published code:** the deployed Functions are
  built from this repository. The replay checks the result, not the binary.
- **The database records are complete:** applications that never reached the
  database (e.g. lost requests, or a user wrongly turned away) are invisible
  to the snapshot.
- **Cryptography:** SHA-256 and BLS12-381 are secure; `drand-client` and
  `@noble/curves` verify correctly.

## What the protocol does not prove

- That the inputs are **true**: tiers, residency, ages and overrides are as
  entered and decided by the organiser. Overrides are counted and
  categorised, not justified; the policy behind tiers is the organiser's.
- That **nobody was excluded or added** before the freeze. A pseudonymous
  family can find its own receipt code in the file; it cannot see whether
  other entries are real people.
- That the freeze happened before round N existed, **independently** of
  Appwrite's clock. Publishing `inputs_hash` somewhere outside Appwrite at
  freeze time (a timestamping service, a public post) would remove that
  assumption; this version does not.
- That the program **was not created several times** with different
  windows or catalogues and only one kept. Publishing is logged, but a
  deleted draft leaves no trace.
- Anonymity. The file is **pseudonymous**: someone who knows a family's
  number of children, ranked weeks, tier and age groups may recognise its
  record. Names, birthdates and homes are never published.
- That offers after the draw (Task 11) follow the plan; the plan and the
  database placements are compared by the commit layer and the replay, but
  later offer and waitlist movements are separate events.

## Operations

- **Missed freeze deadline** (e.g. job outage): the program stays `open` and
  locked out of freezing; the scheduled job reports `not_frozen` with the
  reason. Choosing a new round would let the operator pick after seeing
  output, so it is deliberately not automated.
- **drand outage:** the run stays pending and is retried every tick; the
  audit page shows the attempts.
- **Draw divergence:** handled by the commit layer (docs/DRAW-ALGORITHM.md);
  logged as `draw_failed`.
