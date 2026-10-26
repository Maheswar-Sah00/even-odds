# The Even Odds draw (`even-odds-draw-v1`)

One pure TypeScript module, [`shared/draw/plan.ts`](../shared/draw/plan.ts),
computes the draw. The server commit layer and the public browser replay
import the same file. It reads no clock, network, database, environment or
global state, and uses its own synchronous SHA-256
([`shared/draw/sha256.ts`](../shared/draw/sha256.ts), checked against
`node:crypto`), so Node.js and browsers produce byte-identical plans
(`tests/e2e/draw-parity.spec.ts` compares 26 cases in Chromium).

## Inputs (`draw-inputs-v2`; `draw-inputs-v1` still verifies)

Frozen before the seed exists. Pseudonymous only:

| Field | Meaning |
|---|---|
| `programId`, `maxWeeks` | Program and the number of snake rounds |
| `sessions[]` | `{ week, ageGroup, capacity }` |
| `applications[]` | `{ publicId, tier, late, siblingMode, withdrawn?, children[] }` |
| `children[]` | `{ ref (ticket ID), rankedWeeks[], ageGroups[], requested }`; age group per ranked week was fixed at submission from the child's age on that week's first day |
| `overrides[]` | `{ publicId }`: approved pre-freeze overrides only. (v1 was `{ publicId, reasonCode, pool }`; reason and pool never affected the draw and are no longer published, see FREEZE-PROTOCOL.md) |

`tier` = verified tier if set, else claimed tier, else the program default.
The **inputs hash** = SHA-256 of the canonical JSON (sorted keys;
applications and overrides sorted by public ID, sessions by week and age group),
so the order rows were read in can never matter.

## Seed

64 lowercase hex characters (32 bytes), from a drand round announced before
applications close. The seed is a separate argument; it is not part of the
inputs hash.

## Lottery order (fixed once)

Sort applications by, in order:

1. **Priority class**: 0 if the family has an approved pre-freeze override, else 1.
   (Override rule v1: an approved override moves a family ahead of every tier.
   Both pools, `general` and `accommodation`, are treated the same; the pool
   is recorded for staff only. Separate accommodation capacity is not
   modelled.)
2. **Tier**, ascending.
3. **On-time before late** (late = submitted after close under an explicit late policy).
4. **Lottery hash** ascending: `SHA-256( seed bytes ‖ UTF-8(publicId) )`.
5. Public ID (tie-break for an identical hash, which is practically impossible).

Submission time is not an input. User preferences and public IDs cannot
influence the seed, which is fixed by drand.

## Snake draft

Rounds `1 … maxWeeks`. Odd rounds traverse the order forwards, even rounds
backwards. In each round every family whose children still want weeks
(`placed < requested`) gets one turn:

- **together_only**: the siblings still wanting weeks are placed together in
  the first week they all ranked and none holds, ordered by the lowest summed
  rank (ties: the first child's ranking), that has a free seat for **each** of
  them in their age group. All of them or none of them (one plan step). Once a
  sibling's request is met, the remaining siblings continue as the group.
- **together_preferred**: as together_only; if no such week exists, each
  child is placed on their own as below.
- **independent** (and any single child): each child takes their
  highest-ranked week with a free seat in their age group that they do not
  already hold. A full week is skipped and the next preference tried.

Preferences naming a week/age group that does not exist are dropped with a
warning. Withdrawn applications take no part.

## Waitlist

For every session, children who ranked it, did not get it, and still wanted
more weeks when the draw ended, in lottery order. Positions start at 1 per session.

## Plan and hashes

`computePlan(inputs, seed)` returns the order, the steps (one per atomic
commit, `kind: "group" | "child"`), the waitlist, warnings and a summary.
`planHash` = SHA-256 of the canonical plan without warnings.

## Commit layer

[`functions/shared/draw-commit.ts`](../functions/shared/draw-commit.ts):

1. `buildDrawInputs(db, program)` reads submitted applications, preferences,
   tickets, sessions and pre-freeze overrides.
2. `startDrawRun` stores the seed, drand round and inputs hash.
3. `executeDrawRun` refuses to start if the inputs hash differs, the program
   is not `frozen`, any seat is already taken, or any capacity changed after
   freeze. It then commits steps from `draw_runs.cursor` through
   `placeGroup()`: a TablesDB transaction with `incrementRowColumn(max)` and
   UNIQUE(program, child, week). It runs batches in parallel, always commits at
   least one batch per call, and stops at a time budget. Idempotency key per
   step is `${drawRunId}:${index}`, so repeats never duplicate.
4. If the database refuses a planned step, the run is marked **failed** at
   that step. Nothing is patched over.
5. Then it writes the waitlist, marks the run completed with the plan hash, and
   moves the program `frozen → drawn` via `transitionProgram`.

The `jobs` Function advances any seeded pending or running draw on every
60-minute tick (90-second budget per run). Organisers can also trigger
`{ job: "draw", drawRunId }`. For programs frozen through the freeze protocol
([FREEZE-PROTOCOL.md](FREEZE-PROTOCOL.md)) the inputs come from the published
snapshot, not live rows, and the seed must re-verify against the drand beacon
before any step is committed.

## Golden example

[`shared/draw/sample.ts`](../shared/draw/sample.ts) is hand-verified:

| Step | Family | Placement | Why |
|---|---|---|---|
| 1 | f6 | f6-c1 → W2/old | Override: first despite tier 2; its "W9" preference is impossible and dropped |
| 2 | a1 | a1-c1 → W1/young + a1-c2 → W1/old | Together-only, tier 0, both fit in W1 |
| 3 | b2 | b2-c1 → W1/young | Tier 1, earlier hash than c3 |
| 4 | c3 | c3-c1 → W2/old | Together-preferred: no common week with room for both (W1/old is full), so it falls back; c3-c2 gets nothing (W1/young full) |
| 5 | d4 | d4-c1 → W2/young | Late: after every on-time tier-1 family |
| — | e5 | — | Withdrawn |

Round 2 (reversed) finds no free seat for b2's second week. Waitlist:
W2/young #1 b2-c1, W1/young #1 c3-c2. Plan hash `e14e914f…66ee`.
