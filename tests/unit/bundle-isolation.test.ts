// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';

/**
 * Builds the real production bundle in memory and scans it for anything
 * privileged. Complements the ESLint import boundary (src/ cannot import
 * node-appwrite, functions/ or scripts/).
 */
describe('browser bundle isolation', () => {
  it('contains no server SDK, API-key plumbing or server secret values', async () => {
    const result = await build({ logLevel: 'silent', build: { write: false, sourcemap: false } });
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
    const code = outputs
      .flatMap((o) => o.output)
      .map((chunk) => (chunk.type === 'chunk' ? chunk.code : String(chunk.source)))
      .join('\n');
    expect(code.length).toBeGreaterThan(1000);

    const forbidden: (string | RegExp)[] = [
      'node-appwrite',
      'X-Appwrite-Key',
      /\.setKey\(/,
      'APPWRITE_API_KEY',
      'CHILD_KEY_SECRET',
      'loadEnvFile',
    ];
    // If a local .env.server exists, its actual secret values must not appear either.
    if (existsSync('.env.server')) {
      const serverEnv = parseEnv(readFileSync('.env.server', 'utf8'));
      for (const name of ['APPWRITE_API_KEY', 'CHILD_KEY_SECRET']) {
        const value = serverEnv[name];
        if (value && value.length >= 16) forbidden.push(value);
      }
    }
    for (const needle of forbidden) {
      const found = typeof needle === 'string' ? code.includes(needle) : needle.test(code);
      expect(found, `bundle must not contain ${typeof needle === 'string' && needle.length > 30 ? 'a server secret value' : String(needle)}`).toBe(false);
    }
  }, 120_000);
});
