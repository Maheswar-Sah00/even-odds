// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatEnvIssues, parseServerEnv } from '../../functions/shared/server-env.ts';

const valid = {
  APPWRITE_ENDPOINT: 'https://sfo.cloud.appwrite.io/v1',
  APPWRITE_PROJECT_ID: 'proj123',
  APPWRITE_DATABASE_ID: 'even-odds',
  APPWRITE_API_KEY: 'k'.repeat(64),
};

describe('parseServerEnv', () => {
  it('accepts a complete configuration; optional values default to null', () => {
    const result = parseServerEnv(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ childKeySecret: null, organiserTeamId: null });
  });

  it('reports missing credentials by name without echoing values', () => {
    const result = parseServerEnv({ APPWRITE_ENDPOINT: 'https://x.io/v1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.variable).sort()).toEqual(['APPWRITE_API_KEY', 'APPWRITE_DATABASE_ID', 'APPWRITE_PROJECT_ID']);
    expect(formatEnvIssues(result.issues)).toContain('.env.server');
  });

  it('rejects placeholders and short secrets', () => {
    expect(parseServerEnv({ ...valid, APPWRITE_API_KEY: '<server-api-key>'.padEnd(40, 'x') }).ok).toBe(false);
    expect(parseServerEnv({ ...valid, CHILD_KEY_SECRET: 'short' }).ok).toBe(false);
    const leaked = parseServerEnv({ ...valid, APPWRITE_API_KEY: 'tooshort' });
    expect(!leaked.ok && JSON.stringify(leaked.issues)).not.toContain('tooshort');
  });
});
