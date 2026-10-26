import { createHash, createHmac, randomBytes } from 'node:crypto';
import { childIdentityMessage, type ChildIdentity } from '../../shared/identity.ts';

export const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * child_key = HMAC-SHA256(server secret, normalised identity). Without the
 * secret it cannot be recomputed from a guessed name + birthdate.
 */
export function childKey(secret: string, identity: ChildIdentity): string {
  if (secret.length < 32) throw new Error('child-key secret must be at least 32 characters');
  return createHmac('sha256', secret).update(childIdentityMessage(identity), 'utf8').digest('hex');
}

/** Keyed hash of a client IP address (domain-separated): limits per network without storing the address. */
export function clientIpHash(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`client-ip
${ip}`, 'utf8').digest('hex');
}

/**
 * Deterministic Appwrite row ID: 2-letter prefix + 34 hex chars of SHA-256
 * (136 bits). Same inputs always give the same ID, so a retried create
 * collides instead of duplicating.
 */
export function deterministicId(prefix: string, ...parts: string[]): string {
  if (!/^[a-z]{2}$/.test(prefix)) throw new Error('prefix must be two lowercase letters');
  return prefix + sha256Hex(parts.join('\u0000')).slice(0, 34);
}

/** Random pseudonymous public ID for a family (32 hex chars). */
export const newPublicId = (): string => randomBytes(16).toString('hex');

/** JSON with recursively sorted object keys, so equal data always hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
