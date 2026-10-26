# Organiser control centre

`/organiser/programs/:programId` (production, organiser Team only) and the
lower half of `/demo` (the judge's own sandbox) show the same tabbed console
(`src/features/console/ProgramConsole.tsx`). Every action goes through one
command set (`shared/console-input.ts`) and one server implementation
(`functions/shared/console.ts`). Only the authorisation differs:

| Caller | api area | Authorised by |
|---|---|---|
| Organiser, production program | `console` (plus the existing `organiser` and `offers` areas) | confirmed member of `APPWRITE_ORGANISER_TEAM_ID`, program owned by that Team, `assertProduction` |
| Judge, own sandbox | `demo` → `{ action: "console", command }` | the caller's own sandbox only (`assertSandboxOf`); no program ID in the request |

## Sections

| Tab | Contents | Writes |
|---|---|---|
| Program & sessions | Publish (production), details, sessions and capacity | capacity (logged) |
| Zones & tiers | Tier labels, zone map, server-side "test a location" | zones (draft only) |
| Demand | Per session: seats, first choices, children ranking it, demand per seat, oversubscribed | — |
| Verification | Queue of submitted applications, priority claims and homes within 50 m of a zone edge first; confirm or change the tier with a reason code | `applications.verified_tier` (logged) |
| Overrides | Pre-freeze overrides with reason code, pool, actor, server time and whether they are in the frozen snapshot | `overrides` (logged) |
| Freeze & draw | Close time, announced drand round, freeze deadline, inputs hash, snapshot counts, beacon, seed, plan hash; freeze button (production) | freeze (logged) |
| Offers & waitlists | Seats by session, outstanding offers, waitlist in lottery order; cancel, process expiries | cancel (logged) |
| Audit & fairness | Staff log (who did what), link to the public audit log, fairness report | — |

Consequential actions (publish, freeze, tier change, override, override
removal, offer cancellation, and in the sandbox fast-forward and reset) ask for
confirmation in a dialog that says what will happen and whether it can be
undone.

## Logging every privileged change

`privileged()` in `functions/shared/console.ts` stages the change, a
`staff_actions` row and a public `audit_log` entry in ONE TablesDB
transaction, so a change without its log cannot commit:

- `staff_actions` (organiser Team only) names the actor (`actor_id`), the
  action, the pseudonymous target (receipt code, session or ticket ref), the
  reason code, before/after detail, the public audit `seq`, and the server
  timestamp (`$createdAt`).
- The public audit entry carries the same event with a pseudonymous
  `staff_ref` (a hash of team and user, never the user ID; the audit module
  refuses keys such as `user_id`).
- The staff row's ID is deterministic per (program, action, actor,
  idempotency key), so a retried request returns `replayed` instead of acting
  twice.

Changes that happen inside other transactions (the freeze, offer
cancellation, a demo draw) write their staff row right after, keyed the same
way.

## Overrides and the frozen snapshot

- An override needs a reason code from a fixed list (no free text), an
  authorised actor (`created_by`, re-checked server-side) and a timestamp
  (`$createdAt`, server time). There is at most one per family
  (`UNIQUE(program_id, family_id)`).
- Overrides and tier decisions can change only while the program is `open`.
  The freeze reads approved overrides (`created_before_freeze = true`) into
  the canonical inputs as receipt IDs only (`draw-inputs-v2`, Task 14), so
  they are inside the published inputs hash; their reason and pool stay in
  the staff log (the public audit entry carries no reason). The draw orders
  override families first (priority class 0) and treats both pools the
  same, and the console says so.
- Race with the freeze: if an override commits in the instant after a
  concurrent freeze, the post-commit check finds it missing from the
  snapshot. It sets `created_before_freeze = false`, appends a
  `change_after_freeze` audit entry and tells the organiser. The snapshot is
  authoritative, so such an override never affects the draw.

## Fairness report

The tab shows the same sections as the public report card
(`/fairness/:programId`, [FAIRNESS.md](FAIRNESS.md)), computed by
`shared/fairness.ts` in the `api` Function from the frozen snapshot (the
authoritative inputs), submission times and the draw's committed placements:
invariants (oversold seats, duplicate placements, children over their
request, unexplained placements, "together only" splits; each must be 0),
placement rates with sample sizes and 95% intervals by family size, tier and
application-time quarter, a first-come counterfactual on the same
applications and seats, and stratified permutation tests. The public page
computes the same report in the visitor's browser from verified artifacts.
