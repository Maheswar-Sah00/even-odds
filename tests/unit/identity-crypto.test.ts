// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertPseudonymous, entryHash, GENESIS_HASH, verifyChain, type AuditEntry } from '../../functions/shared/audit.ts';
import { canonicalJson, childKey, deterministicId, sha256Hex } from '../../functions/shared/crypto.ts';
import { placementRowId } from '../../functions/shared/placement.ts';
import { backoffDelay } from '../../functions/shared/retry.ts';
import { APPWRITE_ID_PATTERN } from '../../shared/config.ts';
import { childIdentityMessage, normaliseBirthdate, normaliseName } from '../../shared/identity.ts';

const secret = 'x'.repeat(64);
const ada = { programId: 'p1', firstName: 'Ada', lastName: 'Byron', birthdate: '2018-12-10' };

describe('identity normalisation', () => {
  it.each([
    ['  José  ', 'jose'],
    ['NÚÑEZ-Smith', 'nunez smith'],
    ["O'Brien", 'o brien'],
    ['Zoë\tAnne', 'zoe anne'],
  ])('normaliseName(%j) = %j', (input, expected) => {
    expect(normaliseName(input)).toBe(expected);
  });

  it('accepts dates and ISO datetimes, rejects impossible dates', () => {
    expect(normaliseBirthdate('2019-04-02T00:00:00.000Z')).toBe('2019-04-02');
    expect(() => normaliseBirthdate('2019-02-30')).toThrow(/real calendar date/);
    expect(() => normaliseBirthdate('04/02/2019')).toThrow();
  });

  it('rejects names with no letters or digits', () => {
    expect(() => childIdentityMessage({ ...ada, firstName: '--' })).toThrow();
  });
});

describe('child key', () => {
  it('is stable across spelling variants and scoped to the program', () => {
    const k = childKey(secret, ada);
    expect(childKey(secret, { ...ada, firstName: ' ADA ', birthdate: '2018-12-10T00:00:00Z' })).toBe(k);
    expect(childKey(secret, { ...ada, programId: 'p2' })).not.toBe(k);
    expect(childKey(secret, { ...ada, birthdate: '2018-12-11' })).not.toBe(k);
  });

  it('depends on the server secret (cannot be recomputed without it)', () => {
    expect(childKey('y'.repeat(64), ada)).not.toBe(childKey(secret, ada));
    expect(() => childKey('short', ada)).toThrow();
  });
});

describe('deterministic IDs and canonical JSON', () => {
  it('produces valid, stable 36-char Appwrite IDs', () => {
    const id = placementRowId('p1', 'child1', 'W1');
    expect(id).toHaveLength(36);
    expect(id).toMatch(APPWRITE_ID_PATTERN);
    expect(placementRowId('p1', 'child1', 'W1')).toBe(id);
    expect(placementRowId('p1', 'child1', 'W2')).not.toBe(id);
    expect(placementRowId('p2', 'child1', 'W1')).not.toBe(id);
    expect(() => deterministicId('X', 'a')).toThrow();
  });

  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[{"y":2,"z":1}]},"b":1}');
  });
});

describe('audit helpers', () => {
  const chain = (): AuditEntry[] => {
    let prev = GENESIS_HASH;
    return ['a', 'b', 'c'].map((event, i) => {
      const payload = canonicalJson({ event });
      const payload_hash = sha256Hex(payload);
      const entry_hash = entryHash(prev, i + 1, event, payload_hash);
      const e = { seq: i + 1, event, payload, payload_hash, prev_hash: prev, entry_hash };
      prev = entry_hash;
      return e;
    });
  };

  it('verifies an intact chain and detects gaps, reordering and edits', () => {
    const entries = chain();
    expect(verifyChain(entries)).toEqual({ ok: true });
    expect(verifyChain(entries.filter((e) => e.seq !== 2))).toMatchObject({ ok: false, seq: 3 });
    expect(verifyChain(entries.map((e) => (e.seq === 2 ? { ...e, event: 'forged' } : e)))).toMatchObject({ ok: false, seq: 2 });
  });

  it('rejects personal-data keys anywhere in the payload, allows pseudonymous ones', () => {
    expect(() => { assertPseudonymous({ families: [{ public_id: 'x', home: [1, 2] }] }); }).toThrow(/families\[0\]\.home/);
    expect(() => { assertPseudonymous({ user_id: 'u' }); }).toThrow();
    expect(() => { assertPseudonymous({ public_id: 'x', description: 'ok', tier: 1, drand_round: 5 }); }).not.toThrow();
  });
});

describe('backoff', () => {
  it('uses full jitter with exponential growth', () => {
    expect(backoffDelay(1, 100, () => 0.999)).toBe(99);
    expect(backoffDelay(4, 100, () => 0.5)).toBe(400);
    expect(backoffDelay(3, 100, () => 0)).toBe(0);
  });
});
