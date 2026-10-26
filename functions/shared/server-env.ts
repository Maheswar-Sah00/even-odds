import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { appwriteId, endpointSchema, type EnvIssue, type EnvResult } from '../../shared/env.ts';

/**
 * Server-only configuration. Lives under functions/, which browser code is
 * forbidden to import (ESLint no-restricted-imports + bundle-scan test).
 */
export interface ServerEnv {
  endpoint: string;
  projectId: string;
  databaseId: string;
  apiKey: string;
  childKeySecret: string | null;
  organiserTeamId: string | null;
}

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const secret = (label: string, min: number) =>
  z
    .string({ error: `${label} is not set` })
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .refine((v) => !v.includes('<'), `${label} still contains a placeholder from the .example file`);

export function parseServerEnv(raw: Readonly<Record<string, string | undefined>>): EnvResult<ServerEnv> {
  const schema = z.object({
    APPWRITE_ENDPOINT: endpointSchema('APPWRITE_ENDPOINT'),
    APPWRITE_PROJECT_ID: appwriteId('APPWRITE_PROJECT_ID'),
    APPWRITE_DATABASE_ID: appwriteId('APPWRITE_DATABASE_ID'),
    APPWRITE_API_KEY: z.preprocess(blankToUndefined, secret('APPWRITE_API_KEY', 32)),
    CHILD_KEY_SECRET: z.preprocess(blankToUndefined, secret('CHILD_KEY_SECRET', 32).optional()),
    APPWRITE_ORGANISER_TEAM_ID: z.preprocess(blankToUndefined, appwriteId('APPWRITE_ORGANISER_TEAM_ID').optional()),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues: EnvIssue[] = parsed.error.issues.map((i) => ({ variable: String(i.path[0] ?? ''), message: i.message }));
    return { ok: false, issues };
  }
  const d = parsed.data;
  return {
    ok: true,
    config: {
      endpoint: d.APPWRITE_ENDPOINT,
      projectId: d.APPWRITE_PROJECT_ID,
      databaseId: d.APPWRITE_DATABASE_ID,
      apiKey: d.APPWRITE_API_KEY,
      childKeySecret: d.CHILD_KEY_SECRET ?? null,
      organiserTeamId: d.APPWRITE_ORGANISER_TEAM_ID ?? null,
    },
  };
}

/**
 * For local scripts and tests: load .env.server (if present) into process.env
 * without overriding variables that are already set, then validate.
 */
export function loadServerEnv(file = '.env.server'): EnvResult<ServerEnv> {
  const path = resolve(process.cwd(), file);
  if (existsSync(path)) process.loadEnvFile(path);
  return parseServerEnv(process.env);
}

export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  return [
    'Server configuration is invalid:',
    ...issues.map((i) => `  - ${i.variable}: ${i.message}`),
    'Copy .env.server.example to .env.server and fill it in (see README).',
  ].join('\n');
}
