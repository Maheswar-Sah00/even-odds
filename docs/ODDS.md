# Odds estimates

Implementation: `shared/odds.ts` (pure, versioned `odds-v1`), run by the
`jobs` Function (`functions/shared/odds-job.ts`) every 60 minutes, the most
often the Free plan allows. Tests: `tests/unit/odds.test.ts` (known outcomes),
`tests/integration/odds.test.ts` (real TablesDB).

## What is shown

- **Chance band per priority tier** of a child getting at least one requested
  week: Very likely (≥ 80%), Likely (60–80%), About even (40–60%), Unlikely
  (20–40%), Very unlikely (< 20%). Never a precise percentage. When the 95%
  Monte Carlo interval spans two bands, both are shown ("Likely to very likely").
- **Demand per place** for every session: children ranking it first, ranking
  it at all, and ranked-at-all ÷ capacity.
- When it was computed, how many applications it used, the model version and
  the seed (`<programId>:<hour>`), so anyone can reproduce it.
- A notice that these are estimates, not guarantees.

## Model (odds-v1)

Monte Carlo over the published draw rules with a seeded PRNG (mulberry32)
standing in for the drand seed. Applicants are put in canonical order by
public ID before simulating, so neither input order nor submission time can
influence the result (`tests/unit/odds.test.ts`, `tests/integration/odds.test.ts`).

1. Order: tier ascending, then on-time before late, then uniformly random.
2. Snake draft over `max_weeks` rounds (odd forward, even reversed); at most one
   more week per child per round, up to the child's requested count.
3. Capacity per (week, age group); a child never holds a week twice.
4. Sibling modes: together-only (all-or-nothing in the best common week),
   together-preferred (together first, then individually), independent.

Iterations: 2,000 (≤ 300 children), 600 (≤ 2,000), 300 above.

## Privacy

The snapshot is public and contains aggregates only: counts per tier and per
session. Tiers with fewer than 5 children are not shown. It never contains
public IDs, family, child or user IDs, names, birthdates, homes or
submission times (asserted by `tests/integration/odds.test.ts`).

## Freeze

From `window_close − 24 h` the snapshot is marked `frozen` and never
recomputed. The UI shows "Frozen since …".

## Live updates

The program page subscribes to exactly one public row via Appwrite Realtime.
If the subscription fails it polls every 5 minutes and says so.
