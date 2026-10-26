import type { Models } from 'node-appwrite';
import type { TableKey } from '../../shared/config.ts';
import type { IntegerColumn, RowData } from '../../shared/schema.ts';
import type { ServerAppwrite } from './appwrite-server.ts';

/** A full row of table K: Appwrite system fields plus the schema's columns. */
export type Row<K extends TableKey> = Models.Row & RowData<K>;

export interface WriteOptions {
  permissions?: string[];
  transactionId?: string;
}

/**
 * Typed, logged access to TablesDB for server code. Every call goes through
 * the request logger, which rethrows failures as ServiceError with a mapped
 * error kind. Table names are keys of SCHEMA, so typos fail type checking.
 */
export function createServerDb(aw: ServerAppwrite) {
  const { tablesDB, databaseId, tables, log } = aw;
  const ref = <K extends TableKey>(table: K) => ({ databaseId, tableId: tables[table] });

  return {
    getRow<K extends TableKey>(table: K, rowId: string, transactionId?: string): Promise<Row<K>> {
      return log.run(`getRow(${table})`, () =>
        tablesDB.getRow<Row<K>>({ ...ref(table), rowId, ...(transactionId ? { transactionId } : {}) }),
      );
    },

    listRows<K extends TableKey>(table: K, queries: string[] = [], transactionId?: string): Promise<Models.RowList<Row<K>>> {
      return log.run(`listRows(${table})`, () =>
        tablesDB.listRows<Row<K>>({ ...ref(table), queries, ...(transactionId ? { transactionId } : {}) }),
      );
    },

    createRow<K extends TableKey>(table: K, rowId: string, data: RowData<K>, opts: WriteOptions = {}): Promise<Row<K>> {
      return log.run(`createRow(${table})`, () =>
        tablesDB.createRow<Row<K>>({
          ...ref(table),
          rowId,
          data: data as never,
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
          ...(opts.transactionId ? { transactionId: opts.transactionId } : {}),
        }),
      );
    },

    updateRow<K extends TableKey>(table: K, rowId: string, data: Partial<RowData<K>>, opts: WriteOptions = {}): Promise<Row<K>> {
      return log.run(`updateRow(${table})`, () =>
        tablesDB.updateRow<Row<K>>({
          ...ref(table),
          rowId,
          data: data as never,
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
          ...(opts.transactionId ? { transactionId: opts.transactionId } : {}),
        }),
      );
    },

    upsertRow<K extends TableKey>(table: K, rowId: string, data: RowData<K>, opts: WriteOptions = {}): Promise<Row<K>> {
      return log.run(`upsertRow(${table})`, () =>
        tablesDB.upsertRow<Row<K>>({
          ...ref(table),
          rowId,
          data: data as never,
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
          ...(opts.transactionId ? { transactionId: opts.transactionId } : {}),
        }),
      );
    },

    /**
     * Bulk upsert (max 100 rows per request on the Free plan). Each row carries
     * its own $id and $permissions.
     */
    upsertRows<K extends TableKey>(table: K, rows: (RowData<K> & { $id: string; $permissions: string[] })[]): Promise<Models.RowList<Row<K>>> {
      return log.run(`upsertRows(${table}) x${rows.length}`, () => tablesDB.upsertRows<Row<K>>({ ...ref(table), rows }));
    },

    /**
     * Bulk update of the rows matching `queries` at the time it runs (verified:
     * rows that no longer match are untouched). Callers MUST scope `queries`.
     */
    updateRowsWhere<K extends TableKey>(table: K, data: Partial<RowData<K>>, queries: string[]): Promise<Models.RowList<Row<K>>> {
      if (queries.length === 0) throw new Error('updateRowsWhere refuses to run without queries');
      return log.run(`updateRows(${table})`, () => tablesDB.updateRows<Row<K>>({ ...ref(table), data: data as never, queries }));
    },

    /** Bulk delete by query. Callers MUST scope `queries` (e.g. by program_id). */
    deleteRowsWhere(table: TableKey, queries: string[]): Promise<unknown> {
      if (queries.length === 0) throw new Error('deleteRowsWhere refuses to run without queries');
      return log.run(`deleteRows(${table})`, () => tablesDB.deleteRows({ ...ref(table), queries }));
    },

    deleteRow(table: TableKey, rowId: string, transactionId?: string): Promise<unknown> {
      return log.run(`deleteRow(${table})`, () =>
        tablesDB.deleteRow({ ...ref(table), rowId, ...(transactionId ? { transactionId } : {}) }),
      );
    },

    /**
     * Dedicated capped increment (NOT Operator.increment, which silently no-ops
     * at the cap). Throws when the result would exceed `max`.
     */
    incrementRowColumn<K extends TableKey>(
      table: K,
      rowId: string,
      column: IntegerColumn<K>,
      opts: { value: number; max?: number; transactionId?: string },
    ): Promise<Row<K>> {
      return log.run(`incrementRowColumn(${table}.${column})`, () =>
        tablesDB.incrementRowColumn<Row<K>>({
          ...ref(table),
          rowId,
          column,
          value: opts.value,
          ...(opts.max === undefined ? {} : { max: opts.max }),
          ...(opts.transactionId ? { transactionId: opts.transactionId } : {}),
        }),
      );
    },

    decrementRowColumn<K extends TableKey>(
      table: K,
      rowId: string,
      column: IntegerColumn<K>,
      opts: { value: number; min?: number; transactionId?: string },
    ): Promise<Row<K>> {
      return log.run(`decrementRowColumn(${table}.${column})`, () =>
        tablesDB.decrementRowColumn<Row<K>>({
          ...ref(table),
          rowId,
          column,
          value: opts.value,
          ...(opts.min === undefined ? {} : { min: opts.min }),
          ...(opts.transactionId ? { transactionId: opts.transactionId } : {}),
        }),
      );
    },

    transactions: {
      begin(ttlSeconds = 60): Promise<Models.Transaction> {
        return log.run('createTransaction', () => tablesDB.createTransaction({ ttl: ttlSeconds }));
      },
      commit(transactionId: string): Promise<Models.Transaction> {
        return log.run('commitTransaction', () => tablesDB.updateTransaction({ transactionId, commit: true }));
      },
      rollback(transactionId: string): Promise<Models.Transaction> {
        return log.run('rollbackTransaction', () => tablesDB.updateTransaction({ transactionId, rollback: true }));
      },
      get(transactionId: string): Promise<Models.Transaction> {
        return log.run('getTransaction', () => tablesDB.getTransaction({ transactionId }));
      },
    },
  };
}

export type ServerDb = ReturnType<typeof createServerDb>;
