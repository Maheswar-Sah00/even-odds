# Judge demo (sandbox)

Open **`/demo`** and press **Start the judge demo**. No sign-up, email or setup:
the button starts an Appwrite guest (anonymous) session, and the server gives
that session its own private, pre-seeded sandbox. The demo script then runs in
about two minutes, most of it the 45-second wait for a live drand round.

Everything in the sandbox is synthetic and labelled: the program name starts
with `[SYNTHETIC]`, every child's name starts with `[SYNTHETIC]`, rows carry
`synthetic: true`, and every sandbox page shows a "Synthetic demo data" badge
and banner.

## What the judge can do

| Step | Control | What really happens (all on TablesDB) |
|---|---|---|
| — | Start / open `/demo` | Registry row, private Team, program, 8 sessions, 2 zone polygons and 16 synthetic households (bulk upserts; tiers from `Query.intersects` / `distanceLessThan` on the polygons) |
| 1 | Two parents, one ticket | A second synthetic household registers the Rivera household's Maya. `createRow(tickets)` is refused by `UNIQUE(program_id, child_key)`; the product path (`ensureTicket`) answers `possible_duplicate` and raises a link request for the original household |
| 2 | Fast-forward to the close | The sandbox's own window is moved so it closed 1 s ago (server time); the demo-timed drand round is announced; the real `freezeProgram` commits status, snapshot, draw run and audit entry in one transaction |
| 3 | Run the draw | The same `advanceDraw` the hourly job uses: waits for the round, fetches the beacon, verifies its BLS signature against the pinned key, derives the seed, commits one `placeGroup` transaction per plan step, writes the waitlist, issues 48 h offers |
| 4 | Full-seat rollback | Two siblings in two age groups, one of them full: both capped increments and both placement rows are staged in one transaction; the commit fails with `capacity_exceeded (attribute_limit_exceeded)` and nothing is kept. Re-read counts are shown before and after |
| 5 | Families reply | Accept / decline / give back for any synthetic household, through `respondForHousehold`, the function real families use |
| 6 | Fast-forward 48 hours | Every pending offer's clock moves 48 h earlier; the real sweep then expires them (server time vs `expires_at`, one transaction each) and promotes the waitlist in lottery order |
| 7 | Replay | `/replay/:programId` verifies the audit chain, the inputs hash, the drand signature (fetched by the browser), the seed and the plan hash, then recomputes every placement |

The judge can also use the product as a family in the same sandbox: create a
household at `/family`, then apply to the sandbox program from `/programs`.
Adding a child called **Synthetic Maya Rivera**, born **2020-09-14** (any
capitalisation or punctuation), shows the duplicate block in the real family
flow.

The **Database inspector** lists each control's operations and the database's
answers, newest first. Every line is built from the server's actual response.
Nothing is scripted.

Below the script is the full **organiser console** for the sandbox (see
[ORGANISER-CONSOLE.md](ORGANISER-CONSOLE.md)), where the judge acts as the
sandbox's organiser: verification queue, overrides, demand, freeze and draw
status, offers, the staff log and the fairness report (also public, for the
sandbox's visitor, at `/fairness/:programId`).

## Isolation (enforced server-side)

- **The browser never names a sandbox.** Demo requests (`api` area `demo`,
  `shared/demo-input.ts`) carry no program ID. The server takes the
  platform-set user ID, looks up the visitor's row in the server-only
  `sandboxes` table and calls `assertSandboxOf(program, caller)` before any
  read or write: the program must be `namespace = "demo"`, `synthetic`, and
  owned by the caller.
- **Production paths refuse demo programs** (`assertProduction`): the
  organiser, console and offers areas and manual jobs runs. Sandbox programs
  belong to their own Team, so the real organiser Team does not match them
  either.
- **Reads** are granted per row to a per-sandbox Appwrite Team with a random
  ID, created by the server, whose only member is the visitor. Another
  visitor gets `404`.
- **Demo time never touches a clock.** Fast-forward moves this sandbox's own
  `window_open`/`window_close`, offer `expires_at`/`offered_at` and
  `offers_issued_at`, records the total in `programs.demo_advanced_ms`, and
  logs every move (`drand_round_announced` / `demo_time_advanced` audit
  entries plus a staff-log row). Expiry, transaction validity and drand
  rounds are still decided by Appwrite server time and the real drand
  network.
- **Demo timing applies only to demo programs** (`timingOf` in
  `shared/freeze/protocol.ts`): round due 45 s after the close, freeze at
  least 15 s before it. Production keeps 3 h / 30 min. A production program's
  round is announced at publish; a sandbox's window is not fixed in advance,
  so its round is announced at the fast-forwarded close. That is still a pure
  function of the close time, and still before the inputs are frozen and
  before the round exists. The browser verifier applies the same rule and
  says which one it used.

## Reset and clean-up

- **Reset** (button with confirmation) is idempotent per request key. It bumps
  the visitor's generation in one transaction, seeds the scenario under a
  fresh program ID, then deletes the previous generation: every row with its
  program ID (including its audit chain, staff log and any application the
  judge made in it), and its synthetic households. Deletion is time-boxed
  per request. Status calls and the hourly job finish anything left over.
- Deletion code only reaches programs found by `sandbox_owner = caller`
  and `namespace = "demo"`, and re-checks each with `assertSandboxOf`.
  Production programs and their audit chains cannot be reached from it.
- The jobs Function removes sandboxes idle for 24 h, including their Team.
- Limits: 40 active sandboxes, 12 resets per visitor per hour (rate-limited
  with a clear message).

## Time limits (measured)

Synchronous Function executions are capped at 30 s on Appwrite Cloud (a
longer one returned "Synchronous function execution timed out"). Each demo
action therefore does a bounded amount of work and the page calls again until
it is done (draw: 6 s budget per call; offer sweep: 5 s). Measured on the
deployed Functions (`npm run smoke:demo`, 2026-10-25): first open with
seeding 8–17 s, freeze 3–10 s, the completing draw call 12–23 s, rollback
2–3 s, 48 h fast-forward 7 s, reset 7 s. Times vary with load.

## Tests

- `tests/integration/sandbox.test.ts`: the whole script against real
  Appwrite, with every claim checked against the rows. Covers concurrent
  first opens, isolation in both directions, the unique-index refusal,
  logged privileged changes, overrides in the frozen snapshot, the live
  draw, the rollback (counts unchanged), demo-time expiry (each
  `expires_at` moved by exactly 48 h, decided by server time), seat
  invariants, an intact audit chain, and an idempotent reset that leaves
  zero rows behind and another visitor's sandbox untouched.
- `tests/e2e-live/judge-demo.spec.ts` (`npm run test:e2e:live`): a real
  browser clicks through the whole script against the deployed backend and
  verifies the replay. Screenshots go to `test-results/judge-demo/`.
- `scripts/smoke-demo.ts` (`npm run smoke:demo`): the same script against
  the deployed Function, with timings.
- `tests/unit/judge-sandbox.test.ts`: timing profiles, the guards, the
  scenario's guarantees (14 children for 3 seats, eligibility, sibling
  modes). The fairness report is tested in `tests/unit/fairness.test.ts` and
  `tests/unit/fairness-page.test.tsx` ([FAIRNESS.md](FAIRNESS.md)).
