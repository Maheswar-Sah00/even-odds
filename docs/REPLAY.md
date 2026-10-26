# Independent replay and audit integrity (Task 13)

Anyone can reproduce a published draw at `/replay/:programId` without trusting
the server. The page loads the public artifacts, asks drand for the random
value itself, and reruns the lottery with the same code the server ran. The
fairness report card built on the verified artifacts is specified separately in
[FAIRNESS.md](FAIRNESS.md). Code:

| Part | File |
|---|---|
| Replay steps (pure; run in browser and in tests) | [`shared/replay/replay.ts`](../shared/replay/replay.ts) |
| Published result format, application order, outcomes | [`shared/replay/result.ts`](../shared/replay/result.ts) |
| Replay bundle (download / upload format) | [`shared/replay/bundle.ts`](../shared/replay/bundle.ts) |
| Placement-by-placement comparison | [`shared/replay/diff.ts`](../shared/replay/diff.ts) |
| Deliberate modifications ("try to break it") | [`shared/replay/tamper.ts`](../shared/replay/tamper.ts) |
| Full audit-log integrity report | `auditIntegrity` in [`shared/audit-chain.ts`](../shared/audit-chain.ts) |
| Loading public rows into a bundle | [`src/features/audit/verify.ts`](../src/features/audit/verify.ts) |
| Publishing the result (server) | [`functions/shared/draw-result.ts`](../functions/shared/draw-result.ts) |
| Page | [`src/features/lottery/ReplayPage.tsx`](../src/features/lottery/ReplayPage.tsx) |

## What is published for the replay

Everything is pseudonymous and readable without signing in (demo sandboxes:
only by their visitor).

| Artifact | Where | Hash anchored in |
|---|---|---|
| Frozen inputs (canonical JSON) | `frozen_inputs.canonical` | `inputs_frozen` audit entry, `programs.inputs_hash`, `draw_runs.inputs_hash` |
| Application order (public IDs, submission order, no timestamps) | `frozen_inputs.application_order` | `inputs_frozen.application_order_hash` (same freeze transaction) |
| drand round and chain | `programs.drand_round` | `program_published` / `drand_round_announced` |
| Beacon randomness and signature (server's copy) | `draw_runs` | `beacon_verified`; the replay prefers drand's own copy |
| Seed, plan hash | `draw_runs` | `beacon_verified`, `draw_completed` |
| **Published result** (`even-odds-result-v1`) | `draw_results.canonical` | `result_published` (same transaction as the row) |
| Live offer outcomes (not hashed) | `draw_results.outcomes` | none: the server's word about events after the draw |

The **published result** is new in Task 13. Placement and waitlist rows carry
real child and family IDs, so they are not public. After a protocol draw
completes, the server **reads the committed placement rows back** (those whose
`draw_run_id` is the run) and the waitlist, maps them to the public ID and the
ticket ref used in the frozen inputs, and publishes them as canonical JSON:

```
{"drawRunId":…,"format":"even-odds-result-v1","inputsHash":…,"placements":[{"ageGroup","childRef","publicId","round","week"},…],
 "planHash":…,"programId":…,"waitlist":[{"ageGroup","childRef","position","publicId","week"},…]}
```

Rules as for the frozen inputs: strict allow-list (an unknown field, such as a
name, is an error), placements sorted by (childRef, week), waitlist by (week,
age group, position), integers only, no whitespace, and a file is accepted
only if re-serializing it gives back the identical text. Because the rows are
read back rather than copied from the plan, a replay that matches the result
shows that the **database** holds what the algorithm computed.

The draw step publishes the result right after the run completes; the offers
sweep retries it if that failed, and refreshes the outcomes. One row per
program (deterministic ID): concurrent publishers commit at most one row and
one `result_published` entry.

The application order is committed at freeze so it cannot be arranged after
the random value is known. It is **not** a draw input; the lottery never
reads it. Programs frozen before Task 13 have none, and the replay says so.

## The steps

`replayBundle(bundle)` runs these in order. A step that cannot run yet is
**pending**; a step after a failure is **not checked**; nothing passes unless
this code computed it. No server verdict (`beacon_verified: true`,
"valid", ...) is ever read.

| # | Step | Recomputed in the browser | Fails when |
|---|---|---|---|
| 1 | Audit log integrity | every record: seq continuity, payload hash, entry hash, link to the previous entry; events the other artifacts imply (`inputs_frozen`, `beacon_verified`, `draw_completed`, `result_published`) | any record is missing, duplicated, malformed or altered, or an implied event is absent |
| 2 | Round announced in advance | `announcedRound(window_close)` with the program's timing profile | round ≠ rule, other chain, or not the logged round |
| 3 | Frozen public inputs | strict canonical parse; record counts | non-canonical file, unknown field, counts differ |
| 4 | Canonical inputs hash | SHA-256 of the file | differs from the program, snapshot, run or `inputs_frozen` |
| 5 | Application order | canonical parse, SHA-256, same set of IDs as the inputs | hash ≠ `inputs_frozen.application_order_hash`, or IDs differ |
| 6 | Frozen before the round existed | `frozen_at` vs round time minus margin | freeze after the deadline (server time, trusted) |
| 7 | drand beacon | fetched **from drand** by the browser; BLS signature checked against the pinned quicknet key | signature invalid, wrong round, or the server stored other randomness |
| 8 | Draw seed | `even-odds-seed-v1` from the verified beacon and the recomputed inputs hash | ≠ `draw_runs.seed` or the logged seed |
| 9 | Lottery replayed | `computePlan` from `shared/draw` | plan hash ≠ the run's or `draw_completed`'s |
| 10 | Published result file | canonical parse, SHA-256, program/run/inputs bound | hash ≠ row or `result_published`, or other inputs |
| 11 | Replayed vs published | every placement (child, week, age group, round, family) and waitlist position | any difference, listed one by one |

If drand cannot be reached, the server's stored beacon is verified instead and
the step says so; its BLS signature is still checked locally, so the copy
cannot be forged, only withheld.

Discrepancies are reported in words, for example: *"The replay gives child
tk3f… a seat in 2027-W27 (8-10), but the published result has no such
placement. The database did not commit a seat the algorithm assigned."*

## Try to break it

The page's **Try to break it** panel (and `tamper()` in tests) modifies one
artifact of the loaded bundle and verifies again, offline:

| Modification | Fails at |
|---|---|
| Raise one family's priority (canonical file, new data) | inputs hash |
| Change the published inputs hash | inputs hash |
| Swap in other randomness | drand beacon |
| Move a placement in the result | published result |
| Edit an audit entry | audit log |

Any other change: **Download bundle**, edit the JSON, **Verify a bundle file**.
A downloaded bundle carries the beacon that was verified, so it replays with
no network. A bundle is only internally consistent by itself: compare its
chain head with the live audit page (or a value you noted) to know it is the
published one.

`tests/unit/replay.test.ts` covers every modification, a forger who rewrites
the hash everywhere except the audit log, a result that is consistently hashed
and logged but differs from the replay (caught placement by placement), a log
cut short, and every audit problem kind. `tests/e2e/replay.spec.ts` checks the
browser reaches the same verdicts as Node.js and drives the page;
`tests/e2e-live/judge-demo.spec.ts` verifies a real sandbox draw on Appwrite
Cloud and tampers with it.

## Audit integrity

`auditIntegrity(records)` checks every record and reports every problem
(`verifyChain` stops at the first): `malformed`, `duplicate` (a fork),
`missing` (a gap in seq), `payload_altered`, `entry_altered`, `link_broken`,
`payload_not_json`. The audit page marks each entry, and the replay lists the
problems with what they mean.

**Cryptographic integrity is not truthfulness.** An intact chain proves that no
published record was edited, removed, reordered or inserted after it was
written. It does not prove that what an organiser entered (tiers, residency,
ages, overrides, capacities) was true, only that it was not changed
afterwards. Entries cut off the **end** of the log cannot be seen from the
chain alone: the replay requires the events implied by the other artifacts,
and shows the chain head so it can be compared later. Server timestamps remain
the platform's word ([FREEZE-PROTOCOL.md](FREEZE-PROTOCOL.md), trust
assumptions).

## Privacy

Only pseudonymous IDs and the fields needed to reproduce the result are
published: public IDs (random, 128-bit), ticket refs, tiers, late flags,
sibling modes, ranked weeks and age groups, requested weeks, override
categories, capacities, and the submission order. Never names, birthdates,
addresses, guardian identities, child keys or exact submission times. Every
public format is an allow-list, so an extra field fails verification rather
than being published silently.
