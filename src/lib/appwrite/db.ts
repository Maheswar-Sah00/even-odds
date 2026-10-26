import type { Models } from 'appwrite';
import type { TableKey } from '@shared/config.ts';
import type { RowData } from '@shared/schema.ts';
import type { BrowserAppwrite } from './client.ts';

export type BrowserRow<K extends TableKey> = Models.Row & RowData<K>;

/**
 * Typed, logged, READ-ONLY access to TablesDB from the browser. Clients hold
 * no write permissions on any table; writes go through server Functions.
 */
export function createBrowserDb(app: BrowserAppwrite) {
  const { tablesDB, config, log } = app;
  const ref = (table: TableKey) => ({ databaseId: config.databaseId, tableId: config.tables[table] });
  return {
    getRow<K extends TableKey>(table: K, rowId: string): Promise<BrowserRow<K>> {
      return log.run(`getRow(${table})`, () => tablesDB.getRow<BrowserRow<K>>({ ...ref(table), rowId }));
    },
    listRows<K extends TableKey>(table: K, queries: string[] = []): Promise<Models.RowList<BrowserRow<K>>> {
      return log.run(`listRows(${table})`, () => tablesDB.listRows<BrowserRow<K>>({ ...ref(table), queries }));
    },
  };
}

export type BrowserDb = ReturnType<typeof createBrowserDb>;
