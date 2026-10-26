import type { Models } from 'node-appwrite';
import { TABLE_KEYS, type TableIds, type TableKey } from '../../shared/config.ts';
import { ServiceError } from '../../shared/errors.ts';
import type { RequestLogger } from '../../shared/log.ts';
import { SCHEMA, type ColumnSpec, type IndexSpec, type TableSpec } from '../../shared/schema.ts';

/**
 * Repeatable, additive schema provisioning for TablesDB.
 *
 * - mode "check": read-only; reports what is missing or different.
 * - mode "apply": creates the database, tables, columns and indexes that are
 *   missing. It NEVER deletes or modifies existing columns, indexes or rows.
 *   Differences in existing objects are reported as "incompatible" for a human
 *   to resolve. Table permissions/rowSecurity drift is only corrected when
 *   `fixPermissions` is set (this changes access, not data).
 */

type AnyColumn = Models.Table['columns'][number];

/** The subset of TablesDB used here; node-appwrite's TablesDB satisfies it. */
export interface ProvisionApi {
  get(params: { databaseId: string }): Promise<Models.Database>;
  create(params: { databaseId: string; name: string }): Promise<Models.Database>;
  getTable(params: { databaseId: string; tableId: string }): Promise<Models.Table>;
  createTable(params: {
    databaseId: string;
    tableId: string;
    name: string;
    permissions?: string[];
    rowSecurity?: boolean;
    description?: string;
  }): Promise<Models.Table>;
  updateTable(params: { databaseId: string; tableId: string; permissions?: string[]; rowSecurity?: boolean }): Promise<Models.Table>;
  createVarcharColumn(p: ColumnBase & { size: number; array?: boolean }): Promise<unknown>;
  createTextColumn(p: ColumnBase): Promise<unknown>;
  createLongtextColumn(p: ColumnBase): Promise<unknown>;
  createIntegerColumn(p: ColumnBase & { min?: number; max?: number }): Promise<unknown>;
  createBooleanColumn(p: ColumnBase): Promise<unknown>;
  createDatetimeColumn(p: ColumnBase): Promise<unknown>;
  createEnumColumn(p: ColumnBase & { elements: string[] }): Promise<unknown>;
  createPointColumn(p: ColumnBase): Promise<unknown>;
  createPolygonColumn(p: ColumnBase): Promise<unknown>;
  createIndex(p: {
    databaseId: string;
    tableId: string;
    key: string;
    type: never;
    columns: string[];
  }): Promise<unknown>;
}

interface ColumnBase {
  databaseId: string;
  tableId: string;
  key: string;
  required: boolean;
  description?: string;
}

export type ItemAction = 'ok' | 'created' | 'missing' | 'incompatible' | 'extra' | 'failed' | 'pending';

export interface ItemReport {
  key: string;
  action: ItemAction;
  detail?: string;
}

export interface TableReport {
  table: TableKey;
  tableId: string;
  action: Exclude<ItemAction, 'extra' | 'incompatible' | 'pending'>;
  settings: ItemReport;
  columns: ItemReport[];
  indexes: ItemReport[];
}

export interface ProvisionReport {
  databaseId: string;
  database: 'ok' | 'created' | 'missing' | 'failed';
  databaseDetail?: string;
  tables: TableReport[];
  /** True when everything matches the schema (after any changes made by this run). */
  inSync: boolean;
  /** True when something needs a human: incompatible, failed or permission drift not fixed. */
  needsAttention: boolean;
}

export interface ProvisionOptions {
  api: ProvisionApi;
  log: RequestLogger;
  databaseId: string;
  tables: TableIds;
  mode: 'check' | 'apply';
  fixPermissions?: boolean;
  /** Max time to wait for asynchronous column/index creation per table. */
  waitMs?: number;
  pollMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const isNotFound = (err: unknown) => err instanceof ServiceError && err.mapped.status === 404;
const errorText = (err: unknown) =>
  err instanceof ServiceError ? `${err.mapped.type ?? err.mapped.kind}: ${err.detail ?? err.message}` : String(err);

// ---- comparison --------------------------------------------------------------

const ACCEPTED_TYPES: Record<ColumnSpec['type'], readonly string[]> = {
  varchar: ['varchar'],
  text: ['text'],
  longtext: ['longtext'],
  integer: ['integer'],
  boolean: ['boolean'],
  datetime: ['datetime'],
  enum: ['enum', 'string'], // enum columns may report type "string" with format "enum"
  point: ['point'],
  polygon: ['polygon'],
};

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Returns human-readable differences between the spec and an existing column. */
export function compareColumn(spec: ColumnSpec, actual: AnyColumn): string[] {
  const a = actual as unknown as Record<string, unknown>;
  const problems: string[] = [];
  const actualType = String(a.type);
  if (!ACCEPTED_TYPES[spec.type].includes(actualType)) problems.push(`type is "${actualType}", schema wants "${spec.type}"`);
  if (spec.type === 'enum' && actualType === 'string' && a.format !== 'enum') problems.push('string column is not an enum');
  if (Boolean(a.required) !== spec.required) problems.push(`required is ${String(a.required)}, schema wants ${String(spec.required)}`);
  const wantsArray = 'array' in spec && spec.array === true;
  if (Boolean(a.array) !== wantsArray) problems.push(`array is ${String(Boolean(a.array))}, schema wants ${String(wantsArray)}`);
  if (spec.type === 'varchar' && a.size !== spec.size) problems.push(`size is ${String(a.size)}, schema wants ${spec.size}`);
  if (spec.type === 'enum' && !sameSet((a.elements as string[] | undefined) ?? [], spec.elements)) {
    problems.push(`elements are [${String(a.elements)}], schema wants [${spec.elements.join(',')}]`);
  }
  if (spec.type === 'integer') {
    // Appwrite reports the type's full range when no bound was given; only compare bounds we set.
    if (spec.min !== undefined && Number(a.min) !== spec.min) problems.push(`min is ${String(a.min)}, schema wants ${spec.min}`);
    if (spec.max !== undefined && Number(a.max) !== spec.max) problems.push(`max is ${String(a.max)}, schema wants ${spec.max}`);
  }
  return problems;
}

export function compareIndex(spec: IndexSpec, actual: Models.ColumnIndex): string[] {
  const problems: string[] = [];
  if (actual.type !== spec.type) problems.push(`type is "${actual.type}", schema wants "${spec.type}"`);
  if (actual.columns.join(',') !== spec.columns.join(',')) {
    problems.push(`columns are (${actual.columns.join(', ')}), schema wants (${spec.columns.join(', ')})`);
  }
  return problems;
}

function compareSettings(spec: TableSpec, table: Models.Table): string[] {
  const problems: string[] = [];
  if (table.rowSecurity !== spec.rowSecurity) problems.push(`rowSecurity is ${String(table.rowSecurity)}, schema wants ${String(spec.rowSecurity)}`);
  if (!sameSet(table.$permissions, spec.permissions)) {
    problems.push(`permissions are [${table.$permissions.join(', ')}], schema wants [${spec.permissions.join(', ')}]`);
  }
  return problems;
}

// ---- creation ----------------------------------------------------------------

function createColumn(api: ProvisionApi, databaseId: string, tableId: string, key: string, spec: ColumnSpec): Promise<unknown> {
  const base = { databaseId, tableId, key, required: spec.required, description: spec.description.slice(0, 255) };
  switch (spec.type) {
    case 'varchar':
      return api.createVarcharColumn({ ...base, size: spec.size, ...(spec.array ? { array: true } : {}) });
    case 'text':
      return api.createTextColumn(base);
    case 'longtext':
      return api.createLongtextColumn(base);
    case 'integer':
      return api.createIntegerColumn({
        ...base,
        ...(spec.min === undefined ? {} : { min: spec.min }),
        ...(spec.max === undefined ? {} : { max: spec.max }),
      });
    case 'boolean':
      return api.createBooleanColumn(base);
    case 'datetime':
      return api.createDatetimeColumn(base);
    case 'enum':
      return api.createEnumColumn({ ...base, elements: [...spec.elements] });
    case 'point':
      return api.createPointColumn(base);
    case 'polygon':
      return api.createPolygonColumn(base);
  }
}

// ---- main ----------------------------------------------------------------------

export async function provisionSchema(opts: ProvisionOptions): Promise<ProvisionReport> {
  const { api, log, databaseId, mode } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? 180_000;
  const pollMs = opts.pollMs ?? 1_500;
  const report: ProvisionReport = { databaseId, database: 'ok', tables: [], inSync: false, needsAttention: false };

  try {
    await log.run('getDatabase', () => api.get({ databaseId }));
  } catch (err) {
    if (!isNotFound(err)) {
      report.database = 'failed';
      report.databaseDetail = errorText(err);
      report.needsAttention = true;
      return report;
    }
    if (mode === 'check') {
      report.database = 'missing';
      return finish(report);
    }
    try {
      await log.run('createDatabase', () => api.create({ databaseId, name: 'Even Odds' }));
      report.database = 'created';
    } catch (createErr) {
      report.database = 'failed';
      report.databaseDetail = errorText(createErr);
      report.needsAttention = true;
      return report;
    }
  }

  for (const key of TABLE_KEYS) {
    report.tables.push(await provisionTable(key, opts.tables[key], SCHEMA[key]));
  }
  return finish(report);

  async function provisionTable(key: TableKey, tableId: string, spec: TableSpec): Promise<TableReport> {
    const getTable = () => log.run(`getTable(${tableId})`, () => api.getTable({ databaseId, tableId }));
    const columnKeys = Object.keys(spec.columns);
    const tr: TableReport = { table: key, tableId, action: 'ok', settings: { key: 'settings', action: 'ok' }, columns: [], indexes: [] };

    let table: Models.Table;
    try {
      table = await getTable();
    } catch (err) {
      if (!isNotFound(err)) {
        return { ...tr, action: 'failed', settings: { key: 'settings', action: 'failed', detail: errorText(err) } };
      }
      if (mode === 'check') {
        return {
          ...tr,
          action: 'missing',
          settings: { key: 'settings', action: 'missing' },
          columns: columnKeys.map((k) => ({ key: k, action: 'missing' as const })),
          indexes: spec.indexes.map((i) => ({ key: i.key, action: 'missing' as const })),
        };
      }
      try {
        table = await log.run(`createTable(${tableId})`, () =>
          api.createTable({
            databaseId,
            tableId,
            name: spec.name,
            permissions: [...spec.permissions],
            rowSecurity: spec.rowSecurity,
            description: spec.description.slice(0, 255),
          }),
        );
        tr.action = 'created';
      } catch (createErr) {
        return { ...tr, action: 'failed', settings: { key: 'settings', action: 'failed', detail: errorText(createErr) } };
      }
    }

    // Table settings (permissions, row security).
    const settingProblems = compareSettings(spec, table);
    if (settingProblems.length > 0) {
      if (mode === 'apply' && opts.fixPermissions) {
        try {
          await log.run(`updateTable(${tableId})`, () =>
            api.updateTable({ databaseId, tableId, permissions: [...spec.permissions], rowSecurity: spec.rowSecurity }),
          );
          tr.settings = { key: 'settings', action: 'created', detail: `fixed: ${settingProblems.join('; ')}` };
        } catch (err) {
          tr.settings = { key: 'settings', action: 'failed', detail: errorText(err) };
        }
      } else {
        tr.settings = { key: 'settings', action: 'incompatible', detail: `${settingProblems.join('; ')} (rerun with --fix-permissions)` };
      }
    }

    // Columns.
    const existingColumns = new Map(table.columns.map((c) => [c.key, c]));
    for (const [colKey, colSpec] of Object.entries(spec.columns)) {
      const existing = existingColumns.get(colKey);
      if (existing) {
        const problems = compareColumn(colSpec, existing);
        const status = String((existing as { status?: string }).status);
        if (problems.length > 0) tr.columns.push({ key: colKey, action: 'incompatible', detail: problems.join('; ') });
        else if (status !== 'available') tr.columns.push({ key: colKey, action: status === 'processing' ? 'pending' : 'failed', detail: `status ${status}` });
        else tr.columns.push({ key: colKey, action: 'ok' });
        continue;
      }
      if (mode === 'check') {
        tr.columns.push({ key: colKey, action: 'missing' });
        continue;
      }
      try {
        await log.run(`createColumn(${tableId}.${colKey})`, () => createColumn(api, databaseId, tableId, colKey, colSpec));
        tr.columns.push({ key: colKey, action: 'created' });
      } catch (err) {
        tr.columns.push({ key: colKey, action: 'failed', detail: errorText(err) });
      }
    }
    for (const c of table.columns) {
      if (!(c.key in spec.columns)) tr.columns.push({ key: c.key, action: 'extra', detail: 'not in schema; left untouched' });
    }

    // Columns are created asynchronously; indexes need them available.
    if (mode === 'apply' && tr.columns.some((c) => c.action === 'created' || c.action === 'pending')) {
      table = await waitFor(getTable, (t) => t.columns.every((c) => String((c as { status?: string }).status) !== 'processing'));
      for (const item of tr.columns) {
        const col = table.columns.find((c) => c.key === item.key);
        const status = String((col as { status?: string } | undefined)?.status);
        if ((item.action === 'created' || item.action === 'pending') && status !== 'available') {
          item.action = status === 'processing' ? 'pending' : 'failed';
          item.detail = `status ${status}${(col as { error?: string } | undefined)?.error ? `: ${(col as { error?: string }).error}` : ''}`;
        } else if (item.action === 'pending') {
          item.action = 'ok';
        }
      }
    }

    // Indexes.
    const existingIndexes = new Map(table.indexes.map((i) => [i.key, i]));
    for (const idx of spec.indexes) {
      const existing = existingIndexes.get(idx.key);
      if (existing) {
        const problems = compareIndex(idx, existing);
        if (problems.length > 0) tr.indexes.push({ key: idx.key, action: 'incompatible', detail: problems.join('; ') });
        else if (existing.status !== 'available') tr.indexes.push({ key: idx.key, action: existing.status === 'processing' ? 'pending' : 'failed', detail: `status ${existing.status}${existing.error ? `: ${existing.error}` : ''}` });
        else tr.indexes.push({ key: idx.key, action: 'ok' });
        continue;
      }
      if (mode === 'check') {
        tr.indexes.push({ key: idx.key, action: 'missing' });
        continue;
      }
      const blocked = idx.columns.find((c) => tr.columns.find((x) => x.key === c)?.action !== 'ok' && tr.columns.find((x) => x.key === c)?.action !== 'created');
      if (blocked) {
        tr.indexes.push({ key: idx.key, action: 'failed', detail: `column "${blocked}" is not available` });
        continue;
      }
      try {
        await log.run(`createIndex(${tableId}.${idx.key})`, () =>
          api.createIndex({ databaseId, tableId, key: idx.key, type: idx.type as never, columns: [...idx.columns] }),
        );
        tr.indexes.push({ key: idx.key, action: 'created' });
      } catch (err) {
        tr.indexes.push({ key: idx.key, action: 'failed', detail: errorText(err) });
      }
    }
    for (const i of table.indexes) {
      if (!spec.indexes.some((s) => s.key === i.key)) tr.indexes.push({ key: i.key, action: 'extra', detail: 'not in schema; left untouched' });
    }

    if (mode === 'apply' && tr.indexes.some((i) => i.action === 'created' || i.action === 'pending')) {
      table = await waitFor(getTable, (t) => t.indexes.every((i) => i.status !== 'processing'));
      for (const item of tr.indexes) {
        const idx = table.indexes.find((i) => i.key === item.key);
        if ((item.action === 'created' || item.action === 'pending') && idx?.status !== 'available') {
          item.action = idx?.status === 'processing' ? 'pending' : 'failed';
          item.detail = `status ${idx?.status ?? 'unknown'}${idx?.error ? `: ${idx.error}` : ''}`;
        } else if (item.action === 'pending') {
          item.action = 'ok';
        }
      }
    }
    return tr;
  }

  async function waitFor(get: () => Promise<Models.Table>, done: (t: Models.Table) => boolean): Promise<Models.Table> {
    const deadline = Date.now() + waitMs;
    let table = await get();
    while (!done(table) && Date.now() < deadline) {
      await sleep(pollMs);
      table = await get();
    }
    return table;
  }
}

function finish(report: ProvisionReport): ProvisionReport {
  const items = report.tables.flatMap((t) => [t.settings, ...t.columns, ...t.indexes]);
  const tableActions = report.tables.map((t) => t.action);
  report.needsAttention =
    report.database === 'failed' ||
    tableActions.includes('failed') ||
    items.some((i) => i.action === 'incompatible' || i.action === 'failed');
  report.inSync =
    (report.database === 'ok' || report.database === 'created') &&
    !tableActions.includes('missing') &&
    !tableActions.includes('failed') &&
    items.every((i) => i.action === 'ok' || i.action === 'created' || i.action === 'extra');
  return report;
}

export function formatReport(report: ProvisionReport): string {
  const lines = [`Database "${report.databaseId}": ${report.database}${report.databaseDetail ? ` (${report.databaseDetail})` : ''}`];
  for (const t of report.tables) {
    const notable = [t.settings, ...t.columns, ...t.indexes].filter((i) => i.action !== 'ok');
    const counts = (items: ItemReport[]) => `${items.filter((i) => i.action === 'ok' || i.action === 'created').length}/${items.length}`;
    lines.push(`  ${t.action.padEnd(8)} ${t.tableId.padEnd(18)} columns ${counts(t.columns)}  indexes ${counts(t.indexes)}`);
    for (const i of notable) lines.push(`      ${i.action.padEnd(12)} ${i.key}${i.detail ? `: ${i.detail}` : ''}`);
  }
  lines.push(report.inSync ? 'Schema is in sync.' : report.needsAttention ? 'Schema NEEDS ATTENTION (see above).' : 'Schema is NOT in sync.');
  return lines.join('\n');
}
