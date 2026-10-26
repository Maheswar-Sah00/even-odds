import { Client, Teams, TablesDB, Users } from 'node-appwrite';
import { DEFAULT_TABLE_IDS, type TableIds } from '../../shared/config.ts';
import { consoleSink, createRequestLogger, type LogSink, type RequestLogger } from '../../shared/log.ts';
import type { ServerEnv } from './server-env.ts';

/**
 * Privileged Appwrite context authenticated with the server API key. Only
 * scripts/, functions/ and integration tests may import this module.
 */
export interface ServerAppwrite {
  readonly client: Client;
  readonly tablesDB: TablesDB;
  readonly users: Users;
  readonly teams: Teams;
  readonly databaseId: string;
  readonly tables: TableIds;
  readonly log: RequestLogger;
}

export function createServerAppwrite(
  env: Pick<ServerEnv, 'endpoint' | 'projectId' | 'apiKey' | 'databaseId'>,
  options: { sink?: LogSink | null; tables?: TableIds } = {},
): ServerAppwrite {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new Error('The server Appwrite client must never be created in a browser.');
  }
  const client = new Client().setEndpoint(env.endpoint).setProject(env.projectId).setKey(env.apiKey);
  return {
    client,
    tablesDB: new TablesDB(client),
    users: new Users(client),
    teams: new Teams(client),
    databaseId: env.databaseId,
    tables: options.tables ?? DEFAULT_TABLE_IDS,
    log: createRequestLogger('server', options.sink === null ? undefined : (options.sink ?? consoleSink)),
  };
}
