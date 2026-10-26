import { describe, expect, it } from 'vitest';
import { parsePublicEnv } from '../../shared/env.ts';

const valid = {
  VITE_APPWRITE_ENDPOINT: 'https://sfo.cloud.appwrite.io/v1',
  VITE_APPWRITE_PROJECT_ID: 'proj123',
  VITE_APPWRITE_DATABASE_ID: 'even-odds',
};

describe('parsePublicEnv', () => {
  it('accepts a complete configuration and applies default table IDs', () => {
    const result = parsePublicEnv(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.endpoint).toBe('https://sfo.cloud.appwrite.io/v1');
    expect(result.config.tables.seat_ledger).toBe('seat_ledger');
    expect(result.config.organiserTeamId).toBeNull();
    expect(result.config.logRequests).toBe(false);
  });

  it('reports every missing required variable by name', () => {
    const result = parsePublicEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.variable).sort()).toEqual([
      'VITE_APPWRITE_DATABASE_ID',
      'VITE_APPWRITE_ENDPOINT',
      'VITE_APPWRITE_PROJECT_ID',
    ]);
  });

  it('treats blank values as missing', () => {
    const result = parsePublicEnv({ ...valid, VITE_APPWRITE_PROJECT_ID: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ variable: 'VITE_APPWRITE_PROJECT_ID', message: expect.stringMatching(/not set/) as unknown });
  });

  it('rejects placeholder values copied from .env.example', () => {
    const result = parsePublicEnv({ ...valid, VITE_APPWRITE_PROJECT_ID: '<project-id>' });
    expect(result.ok).toBe(false);
  });

  it('requires the /v1 suffix and an http(s) URL', () => {
    expect(parsePublicEnv({ ...valid, VITE_APPWRITE_ENDPOINT: 'https://sfo.cloud.appwrite.io' }).ok).toBe(false);
    expect(parsePublicEnv({ ...valid, VITE_APPWRITE_ENDPOINT: 'ftp://x.io/v1' }).ok).toBe(false);
    const trailing = parsePublicEnv({ ...valid, VITE_APPWRITE_ENDPOINT: 'http://localhost/v1/' });
    expect(trailing.ok && trailing.config.endpoint).toBe('http://localhost/v1');
  });

  it('honours table ID overrides and validates them', () => {
    const ok = parsePublicEnv({ ...valid, VITE_APPWRITE_TABLE_PLACEMENTS: 'placements_v2' });
    expect(ok.ok && ok.config.tables.placements).toBe('placements_v2');
    expect(parsePublicEnv({ ...valid, VITE_APPWRITE_TABLE_PLACEMENTS: '-bad' }).ok).toBe(false);
  });
});
