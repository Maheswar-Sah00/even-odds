# Offers and waitlist (Task 11)

After the draw, every placement is an **offer** a family must answer within
48 hours. Declined, expired, given-back and cancelled offers free their seat,
which goes to the next eligible child on the waitlist in strict lottery order.

Code: [`shared/offer-lifecycle.ts`](../shared/offer-lifecycle.ts) (pure rules),
[`functions/shared/offers.ts`](../functions/shared/offers.ts) (database
enforcement and jobs), [`functions/shared/offer-actions.ts`](../functions/shared/offer-actions.ts)
(who may do what), [`functions/api/src/handlers/offers.ts`](../functions/api/src/handlers/offers.ts)
(the `offers` area of the `api` Function).

## Lifecycle

```
              accept            give back
   offered ───────────► accepted ─────────► released
   (pending)│                │
            │ decline        │ organiser cancels
            ├──────► declined└───────────► cancelled
            │ 48 h pass
            ├──────► expired
            │ organiser cancels
            └──────► cancelled
```

`offered` is the pending state (the stored value predates Task 11). Every
transition except `accept` releases the seat. No state is ever re-entered.
Any other transition, or a repeat of one, is refused with a message for the
person who asked (`refusalMessage`).

## How the database enforces it

| Rule | Mechanism (verified, see [VERIFIED-BEHAVIOUR.md](VERIFIED-BEHAVIOUR.md#offers-and-waitlist-task-11)) |
|---|---|
| A seat is never allocated twice or beyond capacity | Seats are only taken by `placeGroup()`: `incrementRowColumn(max = capacity)` in a transaction, cap checked at commit; unique `(program, child, week)` |
| A state is left at most once (no duplicate acceptance, no stale overwrite) | The transition transaction creates an **exit marker** with a deterministic ID per (placement, state left). A second or stale writer fails at commit with `transaction_conflict`. A status read alone is not enough: a write staged after another commit does *not* conflict (verified) |
| A seat is released at most once, and only if the reservation still holds it | Same transaction: exit marker + **seat-release marker** (one per placement, ever) + `decrementRowColumn(min = 0)`; all or nothing |
| Accept vs expire | Both are decided against the transaction's own `$createdAt` (Appwrite server time): accept needs `createdAt < expires_at`, expire needs `createdAt >= expires_at`, and both need the `offered` exit marker, so exactly one can win |
| A child never holds more weeks than requested | `preferences.held_weeks` changes only by capped increment (`max = requested_weeks`) / decrement (`min = 0`) inside the placement or release transaction |
| Retries | Replies carry a client idempotency key (one per user intent, reused on retry). The key row is written in the same transaction as the effect, so a retry returns `replayed` with the committed rows. Reusing a key for a different request is refused |
| Truthful results | Every result is re-read from committed rows after commit (staged values are mocks) |

## The 48-hour clock

- **Draw offers** are issued once the draw completes (`issueOffers`, called
  by the `jobs` Function right after the draw and again on every tick until it
  succeeds): `held_weeks` is set from committed placements, then a conditional
  bulk update gives every draw offer `offered_at` = Appwrite server time and
  `expires_at` = that + 48 h (rows that already have a clock are never
  touched), then `programs.offers_issued_at` opens replies. That flag is
  committed with a one-time marker, so duplicate runs cannot issue twice.
- **Waitlist offers** get `offered_at` = their placing transaction's
  `$createdAt` and `expires_at` = that + 48 h.
- Families cannot reply before `offers_issued_at` is set (`locked`).
- Past `expires_at` an offer cannot be accepted or declined even if the sweep
  has not run yet. Readers see it as **lapsed**.

## Promotion (strict lottery order)

When seats are free in a week, `promoteWaitlist` walks that week's waiting
entries by `waitlist.rank` (the family's position in the draw's lottery order,
written by the draw), then position. For each family:

- **together_only**: all eligible waiting siblings at once, each in their own
  age group, or none (the family keeps its place and the next family is tried);
- **together_preferred**: all together if possible, otherwise one by one;
- **independent / one child**: one by one.

A child is eligible while its application is submitted and
`held_weeks < requested_weeks`. Free-seat counts read beforehand only decide
whether an attempt is worth making. Whether a seat exists is decided by the
capped increment at commit. If a re-read shows seats were freed mid-pass, the
pass restarts from the top of the order. The waitlist entry flips to
`promoted` in the same transaction as the placement. Promotion runs right
after a decline, give-back or cancellation (inside the `api` call, best
effort) and on every sweep (the backstop).

## Jobs and limits

The Free plan allows 2 Functions and a 60-minute minimum interval (verified),
so expiry runs as one guarded step of the hourly `jobs` tick
(`runOfferSweep`): issue due offers, expire lapsed ones (oldest first, pages
of 25, 4 at a time), promote, recount public stats, stamp
`programs.offers_swept_at`. It gets whatever is left of the 120 s timeout
after the draw step (at least 10 s). Everything is re-derived from committed
rows, so an interrupted, retried or doubled sweep resumes or no-ops.
Duplicates collapse onto the same markers and idempotency keys. Organisers
can run the same sweep for one program from the console (`process`, 20 s
budget inside the 30 s `api` timeout) or via `jobs` `{ job: "offers", programId? }`.

Because the tick is hourly, a lapsed offer's seat can wait up to about an hour
before it is re-offered. It can never be accepted in that window.

## Who sees what

| Audience | Sees | How |
|---|---|---|
| Family | Its own offers (status, expiry countdown from the server clock, source), waitlist positions and how many are still waiting ahead | `offers.mine`; replies via `offers.respond` |
| Organiser | Per-session counts, every outstanding offer and waitlist entry by **receipt code** (application `public_id`) and **ticket ref**, never names; can cancel offers and run the sweep | `offers.overview` / `cancel` / `process`, Team membership re-checked |
| Public | Counts only per session: places, awaiting reply, accepted, free, waiting, offered from waitlist | `offer_stats` table (public read, no family columns). Releases and promotions are also appended to the public audit log under ticket refs (`offers_issued`, `offers_released`, `offers_cancelled`, `offers_swept`) |

## Tests

- `tests/unit/offer-lifecycle.test.ts`: transition table, no re-entry, request validation.
- `tests/integration/offer-primitives.test.ts`: the TablesDB behaviour the design depends on.
- `tests/integration/offers.test.ts` (real Cloud): concurrent acceptance of one offer; accept racing
  decline; two families competing for the final seat; duplicate promotion jobs with a freed seat;
  simultaneous expiry processing; accept racing expiry at the deadline; five simultaneous sweeps over
  a contested week with sibling rules; a child waitlisted in two weeks; crash recovery; deadline-bounded
  sweeps; organiser cancellation; public, organiser and family views; and an end-to-end run after a real
  draw. After each scenario, `assertInvariants` checks from committed rows that `taken` equals the offers
  holding the ledger and is at most capacity, that `held_weeks` equals weeks held and is at most
  requested, and that waitlist status agrees with placements.
- `tests/integration/offers-function.test.ts`: the deployed `api` Function, with real sessions.
