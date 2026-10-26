# Fairness report card (Task 13)

What the public report card at `/fairness/:programId` measures, where each
number comes from, and what it cannot tell you. Code:

| Part | File |
|---|---|
| Metrics, first-come baseline, bias tests (pure) | [`shared/fairness.ts`](../shared/fairness.ts) |
| Building the report from verified artifacts | [`src/features/fairness/fairness-data.ts`](../src/features/fairness/fairness-data.ts) |
| Public page (and the sections the organiser console reuses) | [`src/features/fairness/FairnessPage.tsx`](../src/features/fairness/FairnessPage.tsx) |
| Tests | [`tests/unit/fairness.test.ts`](../tests/unit/fairness.test.ts) |

## Where the numbers come from

The page runs the same browser replay as `/replay/:programId`
(`verifyProgram`, docs/REPLAY.md) and only uses artifacts whose own checks
passed in the visitor's browser:

| Input | Artifact | Trust |
|---|---|---|
| Families: public ID, tier, late, override, sibling mode, children's ranked weeks, age groups, requested weeks | frozen inputs (`frozen_inputs.canonical`) | Re-hashed; must match `programs.inputs_hash` and the `inputs_frozen` audit entry |
| Capacity the draw ran with | frozen inputs, `sessions` | as above |
| Submission order (public IDs only, no times) | `frozen_inputs.application_order`, committed in the freeze transaction | Re-hashed; must match the hash in the `inputs_frozen` audit entry |
| Placements and waitlist the draw committed | published result (`draw_results.canonical`) | Re-hashed; compared with the replayed plan (a mismatch is shown in red above the report) |
| Offer and waitlist status now | `draw_results.outcomes` | **Live, unhashed**: the server's word about events after the draw, labelled as such |
| Capacity and seats held now | `offer_stats` | **Live, unhashed**, used only for the "oversold now" check |

Nothing is read from a server verdict, and nothing on the page is a constant:
if an artifact fails verification the report is not shown, and the failing
step says why. The organiser console's "Audit & fairness" tab shows the same
sections, computed by the `api` Function from committed rows
(`functions/shared/console.ts`).

Programs frozen before the application order was recorded have no committed
order. For them, time groups and the first-come baseline are **not
computed**; the page says so instead of estimating.

## Metrics

A family "got a week" if the draw gave at least one of its children at least
one week. Every rate row shows the number of families and children in the
group, the count and share placed, and a 95% Wilson score interval (honest at
small sizes, unlike ±1.96·SE). Groups under 10 families are flagged "small
sample".

| Metric | Definition |
|---|---|
| Seats allocated | draw placements / total frozen capacity; unused seats are what nobody eligible could take |
| Oversold seats | Σ over sessions of seats beyond capacity, by the draw's placements against frozen capacity, and by seats held now against capacity now; must be 0 |
| Duplicate placements | (child, week) pairs placed more than once; must be 0 |
| Children over their request | children with more weeks than `min(requested, maxWeeks)`; must be 0 |
| Placements the inputs cannot explain | unknown child, wrong family, a week the child did not rank, the wrong age group for that week, or an unknown session; must be 0 |
| "Together only" split | a family with a week where one sibling is placed while a sibling who never got all their requested weeks is not; must be 0. (Once a sibling's request is met, the others legitimately continue as the group, docs/DRAW-ALGORITHM.md.) |
| By family size | 1, 2, 3+ children |
| By priority tier | effective tier as frozen; lower tiers draw first **by policy** |
| By application time | quarters of the committed submission order (earliest quarter first) |
| Offers | per source (draw, waitlist) and status: awaiting reply, accepted, declined, expired, given back, cancelled |
| Waitlist | entries still waiting, promoted to an offer, removed; children on any waitlist |

## First come, first served (counterfactual)

Computed in the browser on the **same frozen applications and the same
seats**. The draw's own rules apply: priority class (override), tier, on-time
before late, sibling modes, ranked preferences, one week per child per
session, requested weeks capped at `maxWeeks`. Two things change:

1. within each priority group, families are served in **submission order**
   instead of lottery order;
2. each family books all its weeks before the next family starts (no snake
   rounds), as on a first-come booking site.

It is labelled as a counterfactual everywhere. It answers "what would
submission order have done with these same families?", not "what would
families have done under a different system" (people apply differently when
speed matters).

## Statistical tests

**Stratified permutation test** (`stratifiedPermutationTest`), run for three
questions:

1. *Application time*: within each priority group, is getting a week
   associated with the quarter of the submission order? Under the lottery it
   should not be: the lottery hash ignores submission time.
2. *Family size*: the same for 1 / 2 / 3+ children. Some difference is
   **expected from the rules** ("together only" siblings need several seats
   in one week at once; every family, large or small, gets one turn per
   round), so a small p here is not evidence of bias on its own.
3. *First-come baseline, application time*: the same test applied to the
   counterfactual, where time decides the order by construction. This shows
   what a real head start looks like to the test (its power on this data).

Method:

- Families are grouped into strata by (override, tier, late), the factors
  that order the draw **by policy**. Outcomes are only shuffled among
  families of the same stratum, so a tier difference can never look like
  time bias.
- Strata where every family had the same outcome, or only one comparison
  group is present, carry no information and are left out (reported as
  "n of m priority groups had both outcomes").
- Statistic: Pearson χ² of the pooled (got a week × group) table. Effect
  size: Cramér's V = √(χ²/n).
- p-value: Monte Carlo, (1 + #shuffles with χ² ≥ observed) / (1 + shuffles),
  4,000 shuffles. The shuffles are drawn from xoshiro128** seeded with
  SHA-256(`even-odds-fairness-v1` ‖ inputs hash ‖ test), so every browser
  gets the same p-value.
- Not run ("not meaningful here", with the reason) when fewer than 8
  families are in informative strata, or all families fall in one group.

Calibration (unit test): on 12 synthetic oversubscribed programs of 160
families, the lottery's application-time p-values ranged 0.12–0.80, and the
first-come baseline's were at the floor (1/401 at 400 shuffles) every time.

Wording on the page: p < 0.05 is "association found", with the reminder that
this happens 1 time in 20 by chance alone; p ≥ 0.05 is "no evidence of an
association **at this sample size**", never "fair".

## What the report does not show

- Differences between groups do not, on their own, establish discrimination,
  and similar rates do not establish fairness. Groups differ in size, ranked
  weeks, requested weeks and sibling rules.
- No evidence of association is not evidence of no effect; small effects go
  undetected at these sizes.
- Tiers and overrides are the organiser's policy as entered. The report
  checks the draw applied them; it cannot judge whether they were right or
  whether residency, ages and override reasons were true.
- Hashes prove artifacts were not changed after commitment
  (docs/FREEZE-PROTOCOL.md). They do not prove the organiser entered true
  data or included every eligible family.
- The order is committed at freeze, before the drand round exists, but it
  is the server's record of `submitted_at` (Appwrite server time); the
  report cannot check it against anything outside Appwrite.
- Offer outcomes are live, unhashed, and the server's word.

## Privacy

Only the pseudonymous artifacts above are used: receipt codes, ticket refs,
week and age-group codes, tiers and counts. No names, birthdates, addresses,
guardians, family or user IDs, or child keys are published or read. The
application order adds one fact per family (its position in the submission
order) to what the frozen inputs already reveal; it carries no timestamps.
