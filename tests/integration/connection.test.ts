import { Client, TablesDB } from 'node-appwrite';
import { Query } from 'node-appwrite';
import { afterAll, describe, expect, it } from 'vitest';
import { createServerAppwrite } from '../../functions/shared/appwrite-server.ts';
import { provisionSchema } from '../../functions/shared/provisioning.ts';
import { createBrowserAppwrite } from '../../src/lib/appwrite/client.ts';
import { runDiagnostics } from '../../src/lib/appwrite/diagnostics.ts';
import { DEFAULT_TABLE_IDS } from '../../shared/config.ts';
import { mapAppwriteError, ServiceError } from '../../shared/errors.ts';
import { aw, browserGuest, createCleanup, db, newId, serverEnv, syntheticProgram } from './helpers/server.ts';

const cleanup = createCleanup();
afterAll(() => cleanup.run());

const captureError = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
};

describe('TablesDB connection (real Appwrite)', () => {
  it('pings the project with the server key', async () => {
    await expect(aw.client.ping()).resolves.toMatchObject({ message: 'Pong!' });
  });

  it('schema matches shared/schema.ts (db:check is in sync)', async () => {
    const report = await provisionSchema({ api: aw.tablesDB, log: aw.log, databaseId: aw.databaseId, tables: aw.tables, mode: 'check' });
    expect(report.inSync, JSON.stringify(report.tables.filter((t) => t.action !== 'ok'))).toBe(true);
  });

  it('round-trips a row: create, read, update, list, delete', async () => {
    const rowId = cleanup.track('programs', newId());
    const data = syntheticProgram();
    const created = await db.createRow('programs', rowId, data);
    expect(created.$id).toBe(rowId);

    const read = await db.getRow('programs', rowId);
    expect(read).toMatchObject({ name: data.name, max_weeks: 3, status: 'draft', synthetic: true });
    expect(new Date(read.window_open).toISOString()).toBe(data.window_open);

    await db.updateRow('programs', rowId, { status: 'open' });
    const listed = await db.listRows('programs', [Query.equal('$id', rowId)]);
    expect(listed.total).toBe(1);
    expect(listed.rows[0]?.status).toBe('open');

    await db.deleteRow('programs', rowId);
    const err = await captureError(() => db.getRow('programs', rowId));
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).mapped).toMatchObject({ kind: 'not_found', status: 404, type: 'row_not_found' });
  });
});

describe('browser boundary (real Appwrite, browser SDK as guest)', () => {
  const programId = newId();

  it('guest can read published rows (not drafts) but cannot write them', async () => {
    cleanup.track('programs', programId);
    // Published programs carry a read("any") row grant (drafts have none).
    await db.createRow('programs', programId, syntheticProgram(), { permissions: ['read("any")'] });
    const draftId = cleanup.track('programs', newId());
    await db.createRow('programs', draftId, syntheticProgram());
    const guest = browserGuest();
    await expect(guest.tablesDB.getRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: draftId })).rejects.toMatchObject({ code: 404 });

    const row = await guest.tablesDB.getRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: programId });
    expect(row.$id).toBe(programId);

    const createErr = await captureError(() =>
      guest.tablesDB.createRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: newId(), data: syntheticProgram() }),
    );
    expect(mapAppwriteError(createErr)).toMatchObject({ status: 401, kind: 'forbidden' });

    const updateErr = await captureError(() =>
      guest.tablesDB.updateRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: programId, data: { status: 'closed' } as Record<string, unknown> }),
    );
    expect(mapAppwriteError(updateErr).status).toBe(401);

    const deleteErr = await captureError(() =>
      guest.tablesDB.deleteRow({ databaseId: serverEnv.databaseId, tableId: 'programs', rowId: programId }),
    );
    expect(mapAppwriteError(deleteErr).status).toBe(401);
    expect((await db.getRow('programs', programId)).status).toBe('draft');
  });

  it('guest cannot read server-only tables and sees no private rows', async () => {
    const guest = browserGuest();
    const idem = await captureError(() => guest.tablesDB.listRows({ databaseId: serverEnv.databaseId, tableId: 'idempotency' }));
    expect(mapAppwriteError(idem)).toMatchObject({ status: 401, type: 'user_unauthorized' });

    // Row-secured tables filter rows rather than erroring: a guest sees none.
    const families = await guest.tablesDB.listRows({ databaseId: serverEnv.databaseId, tableId: 'families' });
    expect(families.total).toBe(0);
  });

  it('browser diagnostics report a working connection', async () => {
    const app = createBrowserAppwrite(
      {
        endpoint: serverEnv.endpoint,
        projectId: serverEnv.projectId,
        databaseId: serverEnv.databaseId,
        organiserTeamId: null,
        tables: DEFAULT_TABLE_IDS,
        logRequests: false,
      },
      false,
    );
    const checks = await runDiagnostics(app);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['endpoint', 'ok'],
      ['database', 'ok'],
    ]);
  });
});

describe('failure modes (real network)', () => {
  it('maps an unreachable endpoint to a network error', async () => {
    const broken = createServerAppwrite({ ...serverEnv, endpoint: 'http://127.0.0.1:9/v1' }, { sink: null });
    const err = await captureError(() => broken.log.run('ping', () => broken.client.ping()));
    expect((err as ServiceError).mapped).toMatchObject({ kind: 'network', retryable: true });
  });

  it('maps an unknown project to a config error', async () => {
    const err = await captureError(() => new Client().setEndpoint(serverEnv.endpoint).setProject('doesnotexist123').ping());
    expect(mapAppwriteError(err)).toMatchObject({ kind: 'config', type: 'project_not_found' });
  });

  it('maps an invalid API key to a config error', async () => {
    const client = new Client().setEndpoint(serverEnv.endpoint).setProject(serverEnv.projectId).setKey('standard_invalid');
    const err = await captureError(() => new TablesDB(client).list({}));
    expect(mapAppwriteError(err)).toMatchObject({ kind: 'config', type: 'api_key_invalid', status: 401 });
  });

  it('browser diagnostics distinguish unprovisioned schema from a broken connection', async () => {
    const app = createBrowserAppwrite(
      { endpoint: serverEnv.endpoint, projectId: serverEnv.projectId, databaseId: 'not-provisioned', organiserTeamId: null, tables: DEFAULT_TABLE_IDS, logRequests: false },
      false,
    );
    const checks = await runDiagnostics(app);
    expect(checks.map((c) => [c.id, c.status, c.errorType])).toEqual([
      ['endpoint', 'ok', undefined],
      ['database', 'warn', 'database_not_found'],
    ]);
  });
});
