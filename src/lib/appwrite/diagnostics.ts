import { Query } from 'appwrite';
import type { ServiceError } from '@shared/errors.ts';
import type { BrowserAppwrite } from './client.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface DiagnosticCheck {
  id: 'endpoint' | 'database';
  label: string;
  status: CheckStatus;
  detail: string;
  /** Raw Appwrite error type, shown to help debugging. */
  errorType?: string;
  ms?: number;
}

const timed = async <T,>(fn: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - started)];
};

function describeFailure(err: ServiceError): Pick<DiagnosticCheck, 'detail' | 'errorType'> {
  return {
    detail: err.detail ? `${err.mapped.message} (${err.detail})` : err.mapped.message,
    ...(err.mapped.type ? { errorType: err.mapped.type } : {}),
  };
}

/**
 * Real connectivity checks, run as a guest from the browser:
 *  1. endpoint: GET /ping reaches the project (proves endpoint, project ID and CORS).
 *  2. database: a guest read of the public `programs` table (proves the schema is
 *     provisioned and public read permissions are in place).
 * No result is ever assumed; a failed step marks later steps as skipped.
 */
export async function runDiagnostics(app: BrowserAppwrite): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  try {
    const [, ms] = await timed(() => app.log.run('ping', () => app.client.ping()));
    checks.push({ id: 'endpoint', label: 'Appwrite endpoint and project', status: 'ok', detail: 'Ping answered.', ms });
  } catch (err) {
    checks.push({ id: 'endpoint', label: 'Appwrite endpoint and project', status: 'fail', ...describeFailure(err as ServiceError) });
    checks.push({ id: 'database', label: 'TablesDB schema', status: 'skipped', detail: 'Skipped: endpoint check failed.' });
    return checks;
  }

  try {
    const [rows, ms] = await timed(() =>
      app.log.run('tablesDB.listRows(programs)', () =>
        app.tablesDB.listRows({
          databaseId: app.config.databaseId,
          tableId: app.config.tables.programs,
          queries: [Query.limit(1)],
        }),
      ),
    );
    checks.push({
      id: 'database',
      label: 'TablesDB schema',
      status: 'ok',
      detail: `Database "${app.config.databaseId}" is readable; ${rows.total} program(s) visible to guests.`,
      ms,
    });
  } catch (err) {
    const serviceError = err as ServiceError;
    const notProvisioned = serviceError.mapped.kind === 'not_provisioned' || serviceError.mapped.kind === 'not_found';
    checks.push({
      id: 'database',
      label: 'TablesDB schema',
      status: notProvisioned ? 'warn' : 'fail',
      ...describeFailure(serviceError),
    });
  }
  return checks;
}
