import { Client as BrowserClient, TablesDB as BrowserTablesDB } from 'appwrite';
import { ID } from 'node-appwrite';
import { createServerAppwrite } from '../../../functions/shared/appwrite-server.ts';
import { createServerDb, type ServerDb } from '../../../functions/shared/db.ts';
import { formatEnvIssues, loadServerEnv } from '../../../functions/shared/server-env.ts';
import type { TableKey } from '../../../shared/config.ts';
import type { RowData } from '../../../shared/schema.ts';

/**
 * Integration tests run against the REAL Appwrite project in .env.server.
 * Missing credentials fail the suite loudly; nothing is mocked or skipped.
 */
const env = loadServerEnv();
if (!env.ok) {
  throw new Error(`${formatEnvIssues(env.issues)}\nIntegration tests need a real Appwrite project and never skip silently.`);
}

export const serverEnv = env.config;
export const aw = createServerAppwrite(serverEnv, { sink: null });
export const db: ServerDb = createServerDb(aw);

/** Unique per test run; every row created by tests is tagged with it. */
export const RUN_ID = `it${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** A guest using the real BROWSER SDK: same code path and permissions as the web app. */
export function browserGuest() {
  const client = new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId);
  return { client, tablesDB: new BrowserTablesDB(client) };
}

/** Tracks rows created by a test file so afterAll can delete them. */
export function createCleanup() {
  const created: { table: TableKey; rowId: string }[] = [];
  return {
    track(table: TableKey, rowId: string) {
      created.push({ table, rowId });
      return rowId;
    },
    async run() {
      for (const { table, rowId } of created.reverse()) {
        await db.deleteRow(table, rowId).catch(() => undefined);
      }
      created.length = 0;
    },
  };
}

export function syntheticProgram(overrides: Partial<RowData<'programs'>> = {}): RowData<'programs'> {
  return {
    org_team_id: 'itest-team',
    name: `[SYNTHETIC] integration test ${RUN_ID}`,
    timezone: 'America/New_York',
    window_open: '2027-01-10T14:00:00.000Z',
    window_close: '2027-02-10T14:00:00.000Z',
    max_weeks: 3,
    status: 'draft',
    synthetic: true,
    ...overrides,
  };
}

export const newId = () => ID.unique();

/** A real user with a real session, using the BROWSER SDK (same path as the web app). */
export async function createSyntheticUser(label: string) {
  const userId = ID.unique();
  await aw.users.create({ userId, email: `synthetic+${label}-${RUN_ID}@example.com`, name: `[SYNTHETIC] ${label}` });
  const session = await aw.users.createSession({ userId });
  const client = new BrowserClient().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId).setSession(session.secret);
  return { userId, client, tablesDB: new BrowserTablesDB(client), remove: () => aw.users.delete({ userId }).catch(() => undefined) };
}
