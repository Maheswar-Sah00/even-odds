import { z } from 'zod';
import { APPWRITE_ID_PATTERN, DEFAULT_TABLE_IDS, TABLE_KEYS, tableEnvVar, type TableIds } from './config.ts';

/** Public (browser-safe) configuration. Contains no secrets by construction. */
export interface PublicConfig {
  endpoint: string;
  projectId: string;
  databaseId: string;
  organiserTeamId: string | null;
  tables: TableIds;
  logRequests: boolean;
}

export interface EnvIssue {
  variable: string;
  message: string;
}

export type EnvResult<T> = { ok: true; config: T } | { ok: false; issues: EnvIssue[] };

type RawEnv = Readonly<Record<string, string | boolean | undefined>>;

/** Treat empty strings as missing so a blank line in .env reads as "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const appwriteId = (label: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string({ error: `${label} is not set` })
      .trim()
      .regex(
        APPWRITE_ID_PATTERN,
        `${label} must be 1-36 characters (a-z, A-Z, 0-9, '.', '-', '_') and not start with a special character`,
      ),
  );

export const endpointSchema = (label: string) => z.preprocess(
  blankToUndefined,
  z
    .string({ error: `${label} is not set` })
    .trim()
    .pipe(z.url({ protocol: /^https?$/, error: `${label} must be an http(s) URL` }))
    .refine((url) => /\/v1\/?$/.test(new URL(url).pathname), {
      error: `${label} must end with '/v1', e.g. https://sfo.cloud.appwrite.io/v1`,
    })
    .transform((url) => url.replace(/\/+$/, '')),
);

const optionalId = (label: string) => z.preprocess(blankToUndefined, appwriteId(label).optional());

function collectIssues(error: z.ZodError, prefix = ''): EnvIssue[] {
  return error.issues.map((issue) => ({
    variable: `${prefix}${String(issue.path[0] ?? '')}`,
    message: issue.message,
  }));
}

/**
 * Validate the VITE_* variables. Pure: pass `import.meta.env` from the browser
 * or a plain object from tests.
 */
export function parsePublicEnv(raw: RawEnv): EnvResult<PublicConfig> {
  const tableShape = Object.fromEntries(
    TABLE_KEYS.map((key) => [tableEnvVar(key), optionalId(tableEnvVar(key))]),
  );
  const schema = z.object({
    VITE_APPWRITE_ENDPOINT: endpointSchema('VITE_APPWRITE_ENDPOINT'),
    VITE_APPWRITE_PROJECT_ID: appwriteId('VITE_APPWRITE_PROJECT_ID'),
    VITE_APPWRITE_DATABASE_ID: appwriteId('VITE_APPWRITE_DATABASE_ID'),
    VITE_APPWRITE_ORGANISER_TEAM_ID: optionalId('VITE_APPWRITE_ORGANISER_TEAM_ID'),
    VITE_LOG_REQUESTS: z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional()),
    ...tableShape,
  });

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: collectIssues(parsed.error) };

  const data = parsed.data as Record<string, string | undefined>;
  const tables = Object.fromEntries(
    TABLE_KEYS.map((key) => [key, data[tableEnvVar(key)] ?? DEFAULT_TABLE_IDS[key]]),
  ) as Record<(typeof TABLE_KEYS)[number], string>;

  return {
    ok: true,
    config: {
      endpoint: parsed.data.VITE_APPWRITE_ENDPOINT,
      projectId: parsed.data.VITE_APPWRITE_PROJECT_ID,
      databaseId: parsed.data.VITE_APPWRITE_DATABASE_ID,
      organiserTeamId: parsed.data.VITE_APPWRITE_ORGANISER_TEAM_ID ?? null,
      tables: Object.freeze(tables),
      logRequests: parsed.data.VITE_LOG_REQUESTS === 'true',
    },
  };
}

/** Names of variables the browser needs, for help text. */
export const REQUIRED_PUBLIC_VARS = [
  'VITE_APPWRITE_ENDPOINT',
  'VITE_APPWRITE_PROJECT_ID',
  'VITE_APPWRITE_DATABASE_ID',
] as const;
