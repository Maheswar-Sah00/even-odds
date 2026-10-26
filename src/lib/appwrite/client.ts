import { Account, Client, TablesDB } from 'appwrite';
import type { PublicConfig } from '@shared/env.ts';
import { consoleSink, createRequestLogger, type RequestLogger } from '@shared/log.ts';

/**
 * Browser Appwrite context. It authenticates only as the signed-in user (or as
 * a guest); it has no API key and can do exactly what row/table permissions
 * allow. Privileged work goes through Appwrite Functions.
 */
export interface BrowserAppwrite {
  readonly config: PublicConfig;
  readonly client: Client;
  readonly account: Account;
  readonly tablesDB: TablesDB;
  readonly log: RequestLogger;
}

export function createBrowserAppwrite(config: PublicConfig, logToConsole = config.logRequests): BrowserAppwrite {
  const client = new Client().setEndpoint(config.endpoint).setProject(config.projectId);
  return {
    config,
    client,
    account: new Account(client),
    tablesDB: new TablesDB(client),
    log: createRequestLogger('browser', logToConsole ? consoleSink : undefined),
  };
}
