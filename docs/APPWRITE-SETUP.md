# Appwrite project setup

Even Odds uses one Appwrite project with **one TablesDB database**. Use two
projects in practice: a scratch project for development and load tests, and a
clean one for judges (exceeding the Free plan quota freezes a project).

## 1. Project and endpoint

1. Create a project at <https://cloud.appwrite.io>.
2. Note the **Project ID** and the regional **endpoint** (shown on the project
   overview, e.g. `https://sfo.cloud.appwrite.io/v1`).

## 2. Web app (CORS)

Console → **Overview → Apps → Add app → Web**. Add one entry per hostname that
serves the frontend:

- `localhost` for development.
- The Appwrite Sites domain (and any custom domain) for production.

Without this, browsers block requests and the status page reports a network error.

## 3. Server API key

Console → **Overview → API keys → Create API key**. Scopes:

| Scope | Used by |
|---|---|
| `databases.read`, `databases.write` | provisioning |
| `tables.read`, `tables.write` | provisioning |
| `columns.read`, `columns.write` | provisioning |
| `indexes.read`, `indexes.write` | provisioning |
| `rows.read`, `rows.write` | functions, seeding, tests |
| `users.read`, `users.write`, `sessions.write` | integration tests (synthetic users), household linking |
| `teams.read`, `teams.write` | organiser team management, tests |

Put it in `.env.server` (git-ignored). It is never sent to the browser: the
browser SDK has no `setKey`, `src/` cannot import server modules (ESLint), and
`tests/unit/bundle-isolation.test.ts` scans the production bundle for the key.

## 4. Database schema

Do not create tables by hand. Run:

```sh
npm run db:provision   # create anything missing (safe to rerun)
npm run db:check       # read-only drift report, exit 1 if not in sync
```

The provisioner never deletes or alters existing columns, indexes or rows; it
reports `incompatible` and `extra` items for a human to resolve. Table
permission drift is fixed only with `npm run db:provision -- --fix-permissions`.

## 5. Authentication

Families sign in with a six-digit email code (Task 5). In Console →
**Auth → Settings**, keep **Email OTP / email token** sign-in enabled. No
passwords or OAuth providers are required.

The judge demo (`/demo`, [JUDGE-DEMO.md](JUDGE-DEMO.md)) also needs **Anonymous**
sessions enabled (on by default; verified on this project 2026-10-25): one click
gives a visitor a guest session and their own private sandbox. The `api`
Function key needs `teams.write` to create the per-sandbox Team, and `jobs`
needs it to remove idle sandboxes; `npm run functions:deploy` sets both.

## 6. Teams (organisers)

Organisers are members of an Appwrite **Team**. Each program row stores its
`org_team_id`; server code grants that team read access on the program's
private rows (never on `family_locations`). Set the team ID in
`VITE_APPWRITE_ORGANISER_TEAM_ID` and `APPWRITE_ORGANISER_TEAM_ID`.

## 7. Permission model

| Table | Table grants | Row security | Row grants (set by server) |
|---|---|---|---|
| draw_runs, audit_log | `read("any")` | off | n/a |
| programs, seat_ledger, zones | none | on | draft: `read(team:<organisers>)`; published: + `read("any")` |
| families, guardians, children, family_locations, link_requests | none | on | `read(user:<each guardian>)` only |
| tickets, applications, preferences, placements, waitlist | none | on | `read(user:<each guardian>)`, `read(team:<organisers>)` |
| overrides | none | on | `read(team:<organisers>)` |
| idempotency, guardian_invites | none | off | none (server only) |

No client is ever granted create, update or delete. All writes are made by
server code with the API key, which validates inputs and recomputes anything
trust-sensitive (tiers, capacity, placements, timestamps).

## 8. Functions

`npm run functions:deploy` builds each `functions/<name>/src/main.ts` into
one file and deploys it with the settings in `scripts/deploy-functions.ts`
(runtime `node-22`, `execute: ["users"]`, minimal key scopes). Secrets from
`.env.server` are stored as secret function variables. Functions identify the
caller from the platform-set `x-appwrite-user-id` header and use the
per-execution dynamic API key; both are verified in
[VERIFIED-BEHAVIOUR.md](VERIFIED-BEHAVIOUR.md).

The Free plan allows **2 Functions** per project and **no cron** (interval
schedules only, minimum 60 minutes), so Even Odds deploys exactly two:

| Function | Purpose | Schedule | Variables |
|---|---|---|---|
| `api` | every user request, routed by `area` (`household`, `organiser`) | — | `APPWRITE_DATABASE_ID`, `CHILD_KEY_SECRET`, `APPWRITE_ORGANISER_TEAM_ID` |
| `jobs` | odds recompute (later: offer expiry) | every 60 min | `APPWRITE_DATABASE_ID`, `APPWRITE_ORGANISER_TEAM_ID` |
