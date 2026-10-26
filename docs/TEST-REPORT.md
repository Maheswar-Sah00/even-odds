# Even Odds release test report (Task 14)

**Date:** 2026-10-25 · **Scope:** seat integrity under load, security, accessibility (WCAG 2.1 AA), reliability · **Build:** working tree after Tasks 1–14 (not yet committed to git)

## Verdict

- **Seat integrity: no failures in the final runs.** In every load and race scenario, the committed database never showed an oversold seat, a split "together only" sibling group, a double placement or a seat released twice. One real defect was found and fixed along the way (duplicate requests at the last seat; see below).
- **Privacy and authorisation: no failures in the final runs.** No test showed one family reaching another's data, a privilege escalation, or a leak of secrets or personal data. Six weaknesses found in review were fixed and are now covered by tests.
- **Accessibility: no automated WCAG 2.1 AA violations** on any offline route or live walkthrough screen; six issues were fixed.
- **Not declared production-ready.** No critical test fails, and the follow-up pass fixed or mitigated every other issue it could. Two items still stand before a launch with real families: a manual screen-reader pass, which cannot be automated, and Appwrite Free-plan burst throttling, a hosting decision. See [open issues](#open-issues).

## Summary of results

| Suite | Command | Tests | Passed | Failed | Notes |
|---|---|---|---|---|---|
| Unit (offline) | `npm test` | 280 | 280 | 0 | 26 files, incl. new `security-hardening` (17) and `map-alternatives` (3) |
| Browser, offline | `npm run test:e2e` | 76 | 76 | 0 | incl. new `a11y.spec.ts` (37): axe on 15 routes (light) and 7 routes (dark theme), keyboard, reflow, reduced motion, replay tables |
| Browser, live | `npm run test:e2e:live` | 1 | 1 | 0 | Full judge walkthrough on the deployed backend, incl. a `draw-inputs-v2` freeze verified by the browser replay; axe on 10 screens; dialog focus |
| Integration (real Appwrite) | `npm run test:integration` | 160 | 160 | 0 | Final full run: 153 of 157. The 3 sandbox failures (a regression from this task) were fixed. `auth-otp` failed only because this task's OTP probe had used up the hourly limit. The follow-up pass re-ran every suite touched since: auth-otp, applications, draw-commit, freeze, freeze-function, household, sandbox and security, **77/77**, including 3 new tests |
| Load and races (real Appwrite) | `npm run test:stress` | 8 | 8 | 0 | Final run, 812 s; evidence in [`docs/test-evidence/stress/`](test-evidence/stress/) |
| Static | `npm run typecheck`, `npm run lint`, `npm run build` | — | pass | — | `npm run check` green |

Failure counts are reported as observed; no failing test was skipped or deleted.

## Environment

| | |
|---|---|
| Backend | Appwrite Cloud, region `sfo`, **Free plan**, TablesDB, server API version 2.6.1 |
| Functions | `api` and `jobs`, runtime `node-22`, redeployed with this task's fixes (deployments `6addf87d…` and `6addf88f…`) |
| Schema | `npm run db:provision`: 25 tables in sync, incl. the new `rate_limits` |
| SDKs | `appwrite` 29.1.0 (browser), `node-appwrite` 31.0.0 |
| Test runner | Node.js 22.17.1, Vitest 5.0.5, Playwright 1.64.1 (Chromium), `@axe-core/playwright` 4.10.2 |
| Machine | Windows 11, one residential connection, so every request in a burst comes from one IP address |
| Data | Every test row is synthetic (`[SYNTHETIC]`, `synthetic: true`, run-tagged IDs) and is deleted afterwards. No real family data exists in the project |

**About the "disposable environment".** The Free plan allows one project with two Functions, so the tests can't get a separate disposable project. Instead every scenario creates its own synthetic program, families and seat ledgers inside the project, tagged with a per-run ID, and removes them afterwards. Programs are isolated by `program_id`, so scenarios cannot affect each other or real data.

## Database stress tests

Every check below reads **committed rows after the race**: seat ledgers, placements, waitlist entries, preferences and idempotency markers. Return values and staged transaction values are recorded as outcomes but are never treated as evidence. Each scenario also re-checks the global invariants:
- `taken` equals the number of holding offers on the ledger, and never exceeds `capacity`;
- each child's `held_weeks` equals the weeks they actually hold, and never exceeds what they requested;
- there is at most one placement per child per week;
- a waitlist entry is `promoted` exactly when a placement exists.

| Scenario | Result | Committed outcome (final run) |
|---|---|---|
| **500 simultaneous attempts at one freed seat** (a family declines; 500 other families race `placeGroup` for the seat) | PASS | 1 placed, 499 `no_capacity`; ledger `taken 1/1`; 1 holding placement. Appwrite throttled 42 attempts in the first wave; all were retried and reached the database (244 retries, 102 s) |
| **500 waitlisted families, 50 duplicate promotion jobs, then 500 simultaneous accepts** of the promoted offer (250 retries of one click + 250 distinct clicks) | PASS | Exactly 1 promotion, to waitlist position 1; 500 accepts → 1 `changed`, 243 `replayed`, 256 `unchanged`; one exit marker; `taken 1/1`. Another family forging the offer ID: `not_found` |
| **Many applicants competing for a nearly full session** (capacity 40, 35 taken; 100 singles + 50 sibling pairs) | PASS | Ledger exactly full (`40/40`), 0 split pairs. 5 seats went to 1 `placed` + 4 `replayed`: those 4 placements committed, their responses were throttled, and the retries **replayed instead of double-booking** |
| **Concurrent sibling-group allocations** (60 young+old pairs, `together_only`, plus 10 young singles; young 6, old 4) | PASS | Young `6/6`, old `0/4`, 0 split pairs: when the singles took every young seat, every pair's old-age increment rolled back with it |
| **Duplicate submissions** (40 copies of one placement request with one key) | PASS | 1 `placed`, 39 `replayed`; `taken 1/5` |
| **Duplicate application submissions** | PASS | Integration (`applications`): 4 at once with one key change nothing. New in `security`: a key reused with an edited application is refused (409), and another household's key replays nothing |
| **Transaction conflicts and retries** (30 accepts of one offer at once, no idempotency key, 2 attempts each) | PASS | 1 `changed` (attempt 1), 29 `unchanged` after a conflict retry; no false "changed"; exactly one exit marker |
| **Concurrent draw workers and interrupted resumes** (4 workers with a 1-step budget each; the cursor is reset to 0 mid-run, as if a crash lost it; dropped connections resume) | PASS **after fix** | All 4 workers `completed`; committed placements exactly equal the plan (19/19 across 4 ledgers, all full); run `completed`, program `drawn` |
| **Duplicate expiry and waitlist jobs** (20 expired offers, 30 waitlisted; 8 sweeps + 4 expiry + 4 promotion jobs at once) | PASS | 20 seat-release markers (each seat released once); 20 promotions in strict order (positions 1–12 young, 1–8 old); ledgers `12/12`, `8/8` |

### Defects found and fixed

1. **Duplicate requests at the last seat reported "no capacity" (reliability; seats were never oversold).**
   - What happened: when two copies of the same placement raced for a ledger's last seat, the first committed. The second's commit failed on the capacity cap before the unique index was checked, so `placeGroup` reported `no_capacity` without noticing that its own request had succeeded.
   - Impact: overlapping draw workers (an hourly tick plus an organiser's manual run, or a demo re-call) marked the run **failed** and the draw stopped for good. This reproduced every time with 4 workers; with 1 worker it did not appear.
   - Fix: on a capacity refusal, `placeGroup` now re-reads its idempotency row first (`functions/shared/placement.ts`).
2. **Overlapping draw workers raced at the start and end of a run.**
   - What happened: a worker whose read was stale could mark a started or completed run as failed. Workers that finished second threw "cannot move from drawn to drawn".
   - Fix: `executeDrawRun` re-reads the run before recording a failure, and treats an already-drawn program as success (`functions/shared/draw-commit.ts`).
3. **Two first requests for a new judge sandbox could fail one visitor with a 500 (found after this report, 2026-10-26).**
   - What happened: when two requests opened the same new sandbox at once (two tabs, or React's development double effect), both seeded it, and the second request's bulk upserts failed with `row_already_exists`. The Function's execution log showed the pair 4 ms apart. No data was wrong: the first request's rows were complete, and nothing was ever doubled.
   - Fix: seeding is idempotent, so the request that loses now waits briefly and runs it again, and its upserts then update the rows that already exist (`seedWithRetry` in `functions/shared/sandbox.ts`). The `api` Function was redeployed, and the live judge-demo walkthrough passes again.

### Run history (not cherry-picked)

| Run | Result | What it showed |
|---|---|---|
| 1 | 7/8 | The draw-workers scenario failed in the test's own `held_weeks` check: a bare draw sets `held_weeks` only when offers are issued. The test was fixed |
| 2 | 6/8 | The draw-workers race above (product defect). Appwrite also returned 429 during setup after a burst of 500 |
| 3 | 2/8 | Platform: 235/500 and 498/500 first-wave 429s, then the endpoint briefly refused connections (`fetch failed`). The suite now retries 429s and dropped connections, as clients do, and cools down between scenarios |
| 4 | 7/8 | Integrity held everywhere. The 500-attempt scenario failed only an over-strict test assertion: 27 attempts were still throttled after 12 retries |
| Final | **8/8** | Above |

## Security review

Method:
- An independent read-only code review of every `api` area, the `jobs` Function, row permissions and public tables found 9 issues: none critical or high, 3 medium, 5 low, 1 informational.
- Each issue was then fixed or recorded as open.
- `tests/integration/security.test.ts` (18 tests) attacks the **deployed** Functions through the browser SDK as a guest, an email-less account, a family, a second family and an organiser.
- `tests/unit/security-hardening.test.ts` (11 tests) covers error redaction, hostile imports and the rate limiter offline.

| Area | Result | Evidence |
|---|---|---|
| Cross-family record access | PASS | Family B gets 404 for A's child, placement and offer rows, and 0 rows when listing A's children. `updateChild`, `registerTicket` and `submitApplication` with A's child are all `not_found` |
| Unauthenticated privileged actions | PASS | Guests get 401 from both Functions before any code runs |
| Unauthorised privileged actions | PASS | Families and email-less accounts get 403 from the console, organiser and offers-organiser areas and from manual `jobs` runs. Organisers get 404 for a demo program reached through production areas |
| Organiser role escalation | PASS | A family cannot create a team membership, change `programs.org_team_id`, change seat capacity or create placements (401). Organiser-team membership stays 0 |
| Client-supplied tier tampering | PASS | `claimedTier` in an application payload is rejected (strict schema) |
| Capacity tampering | PASS | -1, 10001 and 2.5 are rejected and capacity is unchanged |
| Forged offer IDs | PASS | Another family's, a random and a cross-program placement ID are all refused; the offer is unchanged |
| Replay payload manipulation | PASS after fix | An offer key reused for a different reply gets 409. **Fixed:** application keys are now bound to household, program and request (before: one global key, and an edited resubmission was silently "replayed"). **Fixed:** organiser console keys are bound to the request, so capacity A→B→A→B is applied every time (before: the second A→B was silently skipped) |
| Secrets, personal data and internal errors | PASS after fix | No response contains the API key, the child-key secret, a stack trace or a server path. Public tables contain no names, birthdates, emails or coordinates, and private tables are invisible to guests. **Fixed:** `guarded()` returned raw exception text to manual-run and demo callers; it now returns a safe summary and logs the detail |
| CSV injection and malformed imports | PASS after fix | The app has no CSV export. **Fixed:** session labels starting with `=`, `+`, `-` or `@` are refused at import. **Fixed:** `parseZonesGeoJson` threw on `null`, a non-array `features` and `null` features; these are now reported as errors. The 500-row and 200 KB caps, binary garbage and unterminated quotes are handled |
| Rate limiting: OTP | PASS (platform) | Appwrite refuses the 11th email code within an hour (429); the limit is keyed at least partly on IP address |
| Rate limiting: sensitive endpoints | PASS after fix | **Added** per-account fixed-window limits (`rate_limits` table, capped by `incrementRowColumn({ max })`): identity changes 30 a day, applications 30 an hour, invites 10, household 20, offer replies 60. The 11th invite attempt in an hour gets 429. The identity limit makes the birthdate search from finding 1 take more than 100 days |
| Least privilege | PASS after fix | **Fixed:** organisers could read every `tickets.child_key`, which let them confirm guessed identities; tickets are now readable by the household only. **Fixed:** email-less (anonymous demo) accounts could create production households and applications; they now get 403. **Fixed:** the household area accepted other visitors' demo program IDs |
| Demo sandbox exhaustion | PASS after fix | **Fixed:** the 40-sandbox cap counted abandoned sandboxes. It now counts only sandboxes active in the last 30 minutes, with a hard ceiling of 120, **and** at most 10 active per client IP (platform-set `x-appwrite-client-ip`, stored as a keyed hash). Test: an 11th sandbox from one IP is refused |
| Redacted logs | PASS | Function logs record operation, error kind and type only (`runFunction`), never payloads. `guarded()` details go to the log, not the response. Rate-limit rows store a hash of the user ID |

## Accessibility (WCAG 2.1 AA)

Method:
- axe-core with the WCAG 2.0/2.1 A and AA rule sets on 15 routes offline, on the replay page after verifying a bundle, and on 10 screens of the live judge walkthrough: console, inspector, freeze dialog, draw, rollback, expiry, fairness tab, replay with tampering, public fairness report and public audit log.
- Scripted checks for what axe cannot judge.

| Criterion | Result | Evidence / fix |
|---|---|---|
| Automated rules (names, roles, colour contrast, landmarks, ARIA) | PASS | 0 violations offline and live |
| Keyboard-only navigation (2.1.1, 2.4.1, 2.4.3) | PASS after fix | The skip link is first in the tab order and moves focus to the main content. Every control on the home page is reachable with Tab. The mobile menu opens with Enter, and Escape closes it and returns focus. **Fixed:** the home location could only be set by clicking the map; there is now a keyboard alternative (coordinates or the device's location) |
| Focus visible (2.4.7) | PASS after fix | **Fixed:** the three file pickers (replay bundle, GeoJSON, sessions CSV) had no focus ring |
| Focus management in dialogs | PASS | Live walkthrough: Enter opens the freeze dialog and focus moves inside; Escape closes it and focus returns to the button that opened it |
| Screen-reader labels and status announcements (4.1.2, 4.1.3) | PASS after fix | **Fixed:** the replay announced its whole result block on every update; it now announces one sentence. **Fixed:** maps were `role="img"` around keyboard-operable controls; they are now a labelled group |
| Colour contrast (1.4.3, 1.4.11) | PASS (automated) | axe, in the light and the dark theme (the dark theme came with the site redesign after the first pass). Status is never conveyed by colour alone: badges and steps carry text |
| Reduced motion | PASS | With `prefers-reduced-motion: reduce`, no element animates or transitions |
| Accessible map alternatives (1.1.1) | PASS after fix | **Added:** every map lists its zones and tiers as text, linked as the map's description. The organiser zone editor already had a table and GeoJSON import |
| Text-table lottery replay (1.3.1) | PASS | Every replay table has a caption and header cells. Verification steps are a list with a text status |
| Responsive layouts and zoom (1.4.4, 1.4.10, 1.4.12) | PASS after fix | No horizontal scroll at 320 CSS px (= 400 % zoom) on 7 key routes, plus 375 px and 1280 px on all 15 routes. A text-spacing override causes no overflow. **Fixed:** grid columns grew to fit their widest unbreakable child; long codes and badges now wrap |

## Repeatable test procedure

1. `npm ci`, then fill in `.env.local` and `.env.server` (see `README.md`). The server key needs the scopes listed in `.env.server.example`.
2. `npm run db:check`, and if it reports drift, `npm run db:provision`. Then `npm run functions:deploy`.
3. `npm run check` (type check, lint, 280 unit tests, build) and `npm run test:e2e` (76 offline browser tests). Neither touches Appwrite.
4. `npm run test:integration` (about 35 minutes). Run it **in its own hour**: `auth-otp` and `security` together send up to 13 email codes, and Appwrite allows about 10 an hour per IP address.
5. `npm run test:e2e:live` (about 3 minutes; creates and removes one sandbox).
6. `npm run test:stress` (about 14–20 minutes). Run it on its own; Appwrite throttles bursts per IP, so running suites side by side distorts the results. Evidence is rewritten to `docs/test-evidence/stress/*.json`.
7. Compare the counts with this report. Any change in a committed outcome (`taken`, placements, markers, promotions) is a failure, whatever the calls returned.

## Open issues

Follow-up pass ("fix issues", 2026-10-25): each issue found in the first pass is listed with what was done about it and the evidence.

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | Medium (test) | `auth-otp` failed in the full integration run because this task's own OTP probe had used up the IP's hourly email-code allowance | **Resolved.** Re-run with the other affected suites: 4/4 (77/77 across 8 suites). The procedure now says to run the integration suite in its own hour |
| 2 | Medium (privacy) | The published draw inputs listed each receipt ID with its override reason and pool (`accommodation` = an aide, medical or access need), and public audit entries carried override and tier-verification reasons | **Fixed.** New freezes write `draw-inputs-v2`: an override is only a receipt ID. Public audit entries for overrides and tier verifications carry no reason or pool; both stay in the staff-only log. The draw is unchanged (unit test: v1 and v2 give identical plans), and v1 programs still verify. Tests: `sandbox` checks the frozen file and the audit entry contain no reason; `security-hardening` refuses a v2 file that smuggles one in |
| 3 | Medium (availability) | One person with about 40 anonymous sessions could occupy every active demo sandbox | **Fixed.** The Function receives the caller's IP as the platform-set `x-appwrite-client-ip` header (probed; clients cannot forge `x-appwrite-*` headers). Each network may hold at most 10 active sandboxes (stored as a keyed hash, `sandboxes.ip_hash`), so filling the demo needs at least 4 addresses. Test: an 11th sandbox from one IP is refused, while another IP is not affected |
| 4 | Medium (platform) | Appwrite Cloud Free throttles bursts (1–235 of 500 simultaneous requests got 429, varying by run) | **Mitigated.** The browser retries a platform 429 up to 3 times with jittered backoff. This is always safe: the Function never ran. The app's own hourly limits are not retried. Unit-tested. The plan limit itself remains: consider a paid plan, and re-run `test:stress` there, before a large launch |
| 5 | Low (accessibility) | No manual screen-reader pass (NVDA/VoiceOver) | **Open.** This cannot be automated. Roles, names and live regions are checked by axe and scripted tests. Do one manual pass of sign-in, apply, offers and replay before launch |
| 6 | Low (accessibility) | The organiser's "Test a location" tool was click-only | **Fixed.** The same coordinate form as the family location step |
| 7 | Low (privacy) | `updateChild` and `registerTicket` answer "this child already has a ticket in another household" (an identity oracle) | **Mitigated further.** Limited to 30 a day per account (a birthdate search takes more than 100 days). Editing a child into another household's child now also notifies that household (a link request), as registering already did, so probing is visible to the family being probed. Test in `household` |
| 8 | Low (data) | Ticket rows created before the fix kept organiser-team read access | **Fixed.** Migration 003 (`npm run db:migrate:003`) applied: 208 production-namespace tickets changed; a rerun reports 0. Demo-sandbox tickets keep their sandbox-team grant |
| 9 | Low (tests) | Browser test runs collide when two sessions run Playwright at once: one empties `test-results/` under the other (`ENOENT` on trace files) | Procedure: run Playwright suites one at a time. Stress evidence lives outside `test-results/` for this reason |

## External platform constraints and unverified behaviour

- **Free plan:** 2 Functions; interval schedules only; 30 s synchronous executions (demo actions are time-boxed); burst throttling (see open issue 4); about 10 email codes an hour per IP.
- **Not verified:**
  - email delivery to a real inbox;
  - Realtime close to the 250-connection limit;
  - how transactions count against the monthly write quota;
  - the 100-operations-per-transaction limit;
  - behaviour on a paid plan;
  - load from many distinct IP addresses (every test came from one machine).
