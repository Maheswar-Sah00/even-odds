// @vitest-environment node
/**
 * MOCKED: provisioning logic against an in-memory fake of the TablesDB API.
 * This proves the engine's decisions (create missing, report drift, never
 * modify). The same engine is exercised against real Appwrite by
 * `npm run db:provision` and tests/integration/connection.test.ts.
 */
import type { Models } from 'node-appwrite';
import { describe, expect, it } from 'vitest';
import { provisionSchema, type ProvisionApi } from '../../functions/shared/provisioning.ts';
import { DEFAULT_TABLE_IDS } from '../../shared/config.ts';
import { createRequestLogger } from '../../shared/log.ts';
import { SCHEMA } from '../../shared/schema.ts';

type FakeColumn = Record<string, unknown> & { key: string; status: string };

function notFound(type: string) {
  return Object.assign(new Error(type), { code: 404, type });
}

/** In-memory fake that mimics the observable API used by the provisioner. */
function createFake() {
  let database = false;
  const tables = new Map<string, { table: Omit<Models.Table, 'columns' | 'indexes'>; columns: FakeColumn[]; indexes: Models.ColumnIndex[] }>();
  const calls: string[] = [];
  const addColumn = (type: string, extra: Record<string, unknown> = {}) =>
    (p: { tableId: string; key: string; required: boolean; array?: boolean }) => {
      calls.push(`createColumn:${p.tableId}.${p.key}`);
      const t = tables.get(p.tableId);
      if (!t) return Promise.reject(notFound('table_not_found'));
      t.columns.push({ key: p.key, type, required: p.required, array: p.array ?? false, status: 'available', ...extra, ...pick(p) });
      return Promise.resolve({});
    };
  const pick = (p: object) => {
    const { size, elements, min, max } = p as Record<string, unknown>;
    return { size, elements, min, max };
  };

  const api: ProvisionApi = {
    get: () => (database ? Promise.resolve({} as Models.Database) : Promise.reject(notFound('database_not_found'))),
    create: () => {
      calls.push('createDatabase');
      database = true;
      return Promise.resolve({} as Models.Database);
    },
    getTable: ({ tableId }) => {
      const t = tables.get(tableId);
      return t ? Promise.resolve({ ...t.table, columns: t.columns, indexes: t.indexes } as unknown as Models.Table) : Promise.reject(notFound('table_not_found'));
    },
    createTable: (p) => {
      calls.push(`createTable:${p.tableId}`);
      tables.set(p.tableId, {
        table: { $id: p.tableId, $permissions: p.permissions ?? [], rowSecurity: p.rowSecurity ?? false } as unknown as Models.Table,
        columns: [],
        indexes: [],
      });
      return api.getTable(p);
    },
    updateTable: (p) => {
      calls.push(`updateTable:${p.tableId}`);
      const t = tables.get(p.tableId);
      if (t) Object.assign(t.table, { $permissions: p.permissions, rowSecurity: p.rowSecurity });
      return api.getTable(p);
    },
    createVarcharColumn: addColumn('varchar'),
    createTextColumn: addColumn('text'),
    createLongtextColumn: addColumn('longtext'),
    createIntegerColumn: addColumn('integer'),
    createBooleanColumn: addColumn('boolean'),
    createDatetimeColumn: addColumn('datetime'),
    createEnumColumn: addColumn('string', { format: 'enum' }),
    createPointColumn: addColumn('point'),
    createPolygonColumn: addColumn('polygon'),
    createIndex: (p) => {
      calls.push(`createIndex:${p.tableId}.${p.key}`);
      tables.get(p.tableId)?.indexes.push({ key: p.key, type: String(p.type), columns: p.columns, status: 'available' } as Models.ColumnIndex);
      return Promise.resolve({});
    },
  };
  return { api, calls, tables, hasDatabase: () => database };
}

const run = (api: ProvisionApi, mode: 'check' | 'apply', fixPermissions = false) =>
  provisionSchema({ api, log: createRequestLogger('test'), databaseId: 'db', tables: DEFAULT_TABLE_IDS, mode, fixPermissions, sleep: () => Promise.resolve() });

describe('provisionSchema (mocked API)', () => {
  it('check mode on an empty project reports missing and writes nothing', async () => {
    const fake = createFake();
    const report = await run(fake.api, 'check');
    expect(report).toMatchObject({ database: 'missing', inSync: false });
    expect(fake.calls).toEqual([]);
  });

  it('apply creates everything, then a rerun is a no-op', async () => {
    const fake = createFake();
    const first = await run(fake.api, 'apply');
    expect(first.inSync).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith('createTable'))).toHaveLength(Object.keys(SCHEMA).length);

    fake.calls.length = 0;
    const second = await run(fake.api, 'apply');
    expect(second.inSync).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('reports incompatible columns and extra columns without modifying them', async () => {
    const fake = createFake();
    await run(fake.api, 'apply');
    const ledger = fake.tables.get('seat_ledger');
    const capacity = ledger?.columns.find((c) => c.key === 'capacity');
    if (!capacity) throw new Error('fixture');
    capacity.type = 'varchar';
    ledger?.columns.push({ key: 'legacy_note', type: 'text', required: false, status: 'available' });

    fake.calls.length = 0;
    const report = await run(fake.api, 'apply');
    const table = report.tables.find((t) => t.table === 'seat_ledger');
    expect(table?.columns.find((c) => c.key === 'capacity')).toMatchObject({ action: 'incompatible' });
    expect(table?.columns.find((c) => c.key === 'legacy_note')).toMatchObject({ action: 'extra' });
    expect(report).toMatchObject({ inSync: false, needsAttention: true });
    expect(fake.calls).toEqual([]);
    expect(capacity.type).toBe('varchar');
  });

  it('adds a newly introduced column to an existing table', async () => {
    const fake = createFake();
    await run(fake.api, 'apply');
    const programs = fake.tables.get('programs');
    if (!programs) throw new Error('fixture');
    programs.columns = programs.columns.filter((c) => c.key !== 'timezone');

    fake.calls.length = 0;
    const report = await run(fake.api, 'apply');
    expect(fake.calls).toEqual(['createColumn:programs.timezone']);
    expect(report.inSync).toBe(true);
  });

  it('reports permission drift and only fixes it when asked', async () => {
    const fake = createFake();
    await run(fake.api, 'apply');
    const families = fake.tables.get('families');
    if (!families) throw new Error('fixture');
    Object.assign(families.table, { $permissions: ['read("any")'] });

    const report = await run(fake.api, 'apply');
    expect(report.tables.find((t) => t.table === 'families')?.settings.action).toBe('incompatible');
    expect(families.table.$permissions).toEqual(['read("any")']);

    const fixed = await run(fake.api, 'apply', true);
    expect(fixed.tables.find((t) => t.table === 'families')?.settings.action).toBe('created');
    expect(families.table.$permissions).toEqual([]);
  });

  it('exposes no delete operation at all', () => {
    const fake = createFake();
    expect(Object.keys(fake.api).filter((k) => /delete/i.test(k))).toEqual([]);
  });
});
